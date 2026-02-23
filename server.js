// ─────────────────────────────────────────────────────────────────────────────
// Quanta AI Lab — Inbound Voice Lead Qualification Agent
// Express server bridging Twilio ↔ ElevenLabs ↔ OpenAI ↔ Supabase
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Supabase Client ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Retry wrapper with exponential backoff.
 * @param {Function} fn  — async function to execute
 * @param {number} retries — max retry attempts (default 3)
 * @returns {Promise<*>}
 */
async function withRetry(fn, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(`[retry] Attempt ${attempt} failed, retrying in ${delay}ms…`, err.message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Structured logger.
 */
function log(level, message, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: Health Check
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'quanta-voice-agent', uptime: process.uptime() });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 1: POST /incoming-call
// Twilio fires this when a user dials the Quanta AI Lab number.
// We fetch a signed WebSocket URL from ElevenLabs and return TwiML that
// streams the call audio to the ElevenLabs Conversational AI agent.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/incoming-call', async (req, res) => {
  log('info', 'Incoming call received', {
    from: req.body?.From,
    to: req.body?.To,
    callSid: req.body?.CallSid,
  });

  try {
    // Fetch a one-time signed WebSocket URL from ElevenLabs
    const elResponse = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
      {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
      }
    );

    if (!elResponse.ok) {
      const errorBody = await elResponse.text();
      throw new Error(`ElevenLabs API error ${elResponse.status}: ${errorBody}`);
    }

    const { signed_url } = await elResponse.json();

    // Return TwiML that connects the call audio stream to ElevenLabs
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${signed_url}" />
  </Connect>
</Response>`;

    res.type('text/xml').send(twiml);
    log('info', 'Call connected to ElevenLabs agent', { callSid: req.body?.CallSid });
  } catch (err) {
    log('error', 'Failed to connect call to ElevenLabs', { error: err.message });

    // Return a friendly fallback message so the caller isn't left in silence
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, we're experiencing technical difficulties. Please try again later or email us at hello@quantaailab.com.</Say>
</Response>`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE 2: POST /conversation-end
// ElevenLabs fires this webhook after the conversation ends.
// Pipeline: Parse transcript → Save to Supabase
// ─────────────────────────────────────────────────────────────────────────────
app.post('/conversation-end', async (req, res) => {
  log('info', 'RAW WEBHOOK PAYLOAD', { body: req.body });
  
  const payloadData = req.body?.data || req.body || {};
  const { transcript, metadata, conversation_id } = payloadData;

  log('info', 'Conversation ended', {
    conversationId: conversation_id,
    duration: metadata?.call_duration_secs,
    metadataKeys: metadata ? Object.keys(metadata) : []
  });

  // ── Filter spam / empty calls ──────────────────────────────
  const duration = metadata?.call_duration_secs || 0;
  
  // If we have a transcript but duration is missing/0, we shouldn't discard it.
  // A good call should have at least 3-4 messages (Maya greeting + User response + Maya followup).
  const messageCount = transcript && Array.isArray(transcript) ? transcript.length : 0;
  
  if (duration < 20 && messageCount <= 2) {
    log('info', 'Call too short/empty — discarding', { conversationId: conversation_id, duration, messageCount });
    return res.json({ received: true, action: 'discarded' });
  }

  // Respond immediately so ElevenLabs doesn't time out waiting for us
  res.json({ received: true });

  // ── Process asynchronously ────────────────────────────────────────────────
  try {
    // 1. Parse transcript with OpenAI
    const leadData = await parseTranscriptWithOpenAI(transcript);
    log('info', 'Transcript parsed', { conversationId: conversation_id, leadData });

    // 2. Determine call status
    const callStatus = determineCallStatus(transcript, duration, leadData);

    // 3. Save to Supabase
    await withRetry(async () => {
      const { error } = await supabase.from('leads').insert([
        {
          full_name: leadData.name,
          email: leadData.email,
          company: leadData.company,
          use_case: leadData.useCase,
          budget: leadData.budget,
          timeline: leadData.timeline,
          raw_transcript: JSON.stringify(transcript),
          call_duration_sec: duration,
          call_status: callStatus,
        },
      ]);
      if (error) throw new Error(`Supabase insert error: ${error.message}`);
    });
    log('info', 'Lead saved to Supabase', { conversationId: conversation_id });
  } catch (err) {
    // Critical failure — log full transcript so no lead data is lost
    log('error', 'Post-call processing failed', {
      conversationId: conversation_id,
      error: err.message,
      transcriptBackup: JSON.stringify(transcript),
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION: Determine call status from transcript/duration
// ─────────────────────────────────────────────────────────────────────────────
function determineCallStatus(transcript, duration, leadData) {
  // If no transcript lines exist, likely voicemail or no audio
  if (!transcript || transcript.length === 0) return 'voicemail';

  // If we got very little data and short call, it's abandoned
  const fieldsCollected = [leadData.name, leadData.email, leadData.company, leadData.useCase]
    .filter(Boolean).length;
  if (fieldsCollected <= 1 && duration < 60) return 'abandoned';

  return 'completed';
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNCTION: Parse transcript with OpenAI (gpt-4o-mini)
// Extracts structured lead data from the raw conversation transcript.
// ─────────────────────────────────────────────────────────────────────────────
async function parseTranscriptWithOpenAI(transcript) {
  const fallback = {
    name: null,
    email: null,
    company: null,
    useCase: null,
    budget: null,
    timeline: null,
  };

  if (!transcript || transcript.length === 0) return fallback;

  const fullText = transcript.map((t) => `${t.role}: ${t.message}`).join('\n');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You extract structured data from call transcripts. Always respond with valid JSON only.',
          },
          {
            role: 'user',
            content: `Extract these fields from the following call transcript.

Fields to extract:
- name (string | null) — caller's full name
- email (string | null) — caller's email address
- company (string | null) — caller's company or "Individual"
- useCase (string | null) — what problem they want to solve
- budget (string | null) — budget range, or "unsure" if they don't know
- timeline (string | null) — when they want to start

Transcript:
${fullText}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    return { ...fallback, ...parsed };
  } catch (err) {
    log('error', 'OpenAI transcript parsing failed', { error: err.message });
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `Quanta Voice Agent server running on port ${PORT}`);
  log('info', 'Routes registered', {
    routes: ['GET /health', 'POST /incoming-call', 'POST /conversation-end'],
  });
});
