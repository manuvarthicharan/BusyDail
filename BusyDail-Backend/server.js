import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'child_process';

dotenv.config();

const {
    GEMINI_API_KEY,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY
} = process.env;

if (!GEMINI_API_KEY) { console.error('Missing GEMINI_API_KEY'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
});

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

fastify.addHook('onRequest', (request, reply, done) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (request.method === 'OPTIONS') { reply.code(200).send(); return; }
    done();
});

const SYSTEM_MESSAGE = `You are a real Indian human caller speaking naturally over a phone call.
Your goal is to sound completely human, casual, and natural — not like an AI assistant.
Follow these strict behaviour rules:
1. Speak in Indian conversational English:
* Use natural Indian phrasing like "actually what happened is...", "I will just check and tell", "please check once", "it is like that only"
* Address politely when needed: "sir", "ma'am"
2. Use natural fillers and hesitation:
* Add fillers where appropriate, not in every sentence: "hmm...", "uh...", "okay...", "so...", "actually..."
* Use thinking sounds: "hmm let me see...", "uh okay wait..."
3. Add repetition naturally: "yes yes", "no no", "okay okay", "right right"
4. Simulate human imperfections:
* Do not speak perfect English
* Slightly informal grammar is allowed
* Repeat or restart phrases occasionally: "I mean... actually..."
5. Express emotions subtly:
* If something is funny or light: add small laugh "haha" or "hehe"
* If unsure: "hmm not sure..."
* If apologetic: "sorry about that..."
6. Keep responses VERY SHORT:
* Maximum 1-2 sentences
* Prefer 5-12 words when possible
* Do NOT give explanations unless explicitly asked
* Speak like real phone conversation, not paragraphs
7. Handle conversation naturally:
* If user is silent: "hello... are you there?"
* If user interrupts: "okay sorry, go ahead"
* If ending call naturally: say a casual warm goodbye like "okay then, talk to you later, bye bye!" and append [END_CALL] at the very end of your TEXT response (not spoken)
* If you receive an internal instruction to end the call due to time: naturally say something like "okay so actually I have to rush now, I'll call you back later okay? bye!" or "hmm okay I need to go now, will talk later, bye bye!" — keep it very casual and human, do NOT mention time or limits, and append [END_CALL] at the very end of your TEXT response (not spoken)
8. IMPORTANT - End call detection: If the user says anything that means they want to end the call — directly or indirectly — such as:
* Direct: "bye", "goodbye", "ok bye", "take care", "talk later", "disconnect", "end call"
* Indirect: "I'll let you go", "we'll talk later", "okay that's it", "I think we're done", "nothing else", "that's all", "okay fine", "alright then", "I have to go", "I'm busy now", "call me later", "I'll call you back"
* In any language mix or casual phrasing
Then: respond with a natural warm Indian goodbye, and always append [END_CALL] at the very end of your text response. The [END_CALL] tag will never be spoken — it is only a signal.
9. Do NOT sound like a chatbot, formal assistant, or scripted/robotic
10. Avoid complex vocabulary, long explanations, structured or essay-style responses
11. Always prioritise: natural flow > correctness > completeness
Your speech should feel like a real Indian person talking casually on a phone call.`;

const MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE = 'Aoede';
const PORT = process.env.PORT || 5050;

const GEMINI_WS_URL =
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta` +
    `.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const BACKGROUND_SOUND_URLS = {
    office:      `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/office.mp3`,
    call_center: `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/call_center.mp3`,
    traffic:     `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/traffic.mp3`,
    nature:      `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/nature.mp3`,
    cafe:        `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/cafe.mp3`,
    rain:        `https://atauxjrnhbobpelsiggj.supabase.co/storage/v1/object/public/sounds%20bucket/rain.mp3`,
};

const soundCache = {};

function mulawToLinear(u) {
    u = ~u & 0xFF; let sign = u & 0x80; let exponent = (u >> 4) & 0x07; let mantissa = u & 0x0F;
    let sample = ((mantissa << 1) + 33) << exponent; sample -= 33; return sign ? -sample : sample;
}

function linearToMulaw(sample) {
    const MULAW_MAX = 0x1FFF; const MULAW_BIAS = 33;
    const exp_lut = [0,1,2,2,3,3,3,3,4,4,4,4,4,4,4,4,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
                     6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
                     7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                     7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7];
    let sign = (sample >> 8) & 0x80; if (sign) sample = -sample; if (sample > MULAW_MAX) sample = MULAW_MAX;
    sample += MULAW_BIAS; let exponent = exp_lut[(sample >> 7) & 0xFF]; let mantissa = (sample >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function mulawBase64ToPcm16Base64(mulawBase64) {
    const mulawBuf = Buffer.from(mulawBase64, 'base64');
    const pcm8k = new Int16Array(mulawBuf.length);
    for (let i = 0; i < mulawBuf.length; i++) pcm8k[i] = mulawToLinear(mulawBuf[i]);
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length - 1; i++) {
        pcm16k[i * 2]     = pcm8k[i];
        pcm16k[i * 2 + 1] = Math.round((pcm8k[i] + pcm8k[i + 1]) / 2);
    }
    pcm16k[(pcm8k.length - 1) * 2]     = pcm8k[pcm8k.length - 1];
    pcm16k[(pcm8k.length - 1) * 2 + 1] = pcm8k[pcm8k.length - 1];
    return Buffer.from(pcm16k.buffer).toString('base64');
}

function pcm16Base64ToMulawBase64(pcm16Base64) {
    const pcmBuf = Buffer.from(pcm16Base64, 'base64');
    const pcm24k = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
    const outLen = Math.floor(pcm24k.length / 3);
    const mulaw8k = Buffer.alloc(outLen);
    for (let i = 0; i < outLen; i++) mulaw8k[i] = linearToMulaw(pcm24k[i * 3]);
    return mulaw8k.toString('base64');
}

function convertAudioToPcm24k(inputBuffer) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const ff = spawn('ffmpeg', [
            '-i', 'pipe:0',
            '-f', 's16le',
            '-ar', '24000',
            '-ac', '1',
            '-loglevel', 'quiet',
            'pipe:1'
        ]);

        ff.stdout.on('data', chunk => chunks.push(chunk));
        ff.stdout.on('end', () => {
            const pcmBuf = Buffer.concat(chunks);
            resolve(new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2));
        });
        ff.stderr.on('data', () => {});
        ff.on('error', (err) => reject(new Error(`ffmpeg error: ${err.message}`)));
        ff.stdin.on('error', () => {});

        ff.stdin.write(inputBuffer);
        ff.stdin.end();
    });
}

async function loadSoundPCM(soundId) {
    if (soundCache[soundId]) return soundCache[soundId];
    const url = BACKGROUND_SOUND_URLS[soundId];
    if (!url) return null;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} for sound ${soundId}`);
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        const pcmSamples = await convertAudioToPcm24k(audioBuffer);
        soundCache[soundId] = pcmSamples;
        return pcmSamples;
    } catch (err) {
        console.error(`Failed to load sound ${soundId}:`, err.message);
        return null;
    }
}

function mixSoundIntoAudio(geminiPcm, soundSamples, soundOffset, volumePct) {
    if (!soundSamples || soundSamples.length === 0) {
        return { mixed: geminiPcm, newOffset: soundOffset };
    }
    const vol = Math.max(0, Math.min(100, volumePct)) / 100;
    const mixed = new Int16Array(geminiPcm.length);
    let offset = soundOffset;

    for (let i = 0; i < geminiPcm.length; i++) {
        const bgSample = soundSamples[offset % soundSamples.length];
        const gemSample = geminiPcm[i];
        const mixedVal = gemSample + Math.round(bgSample * vol);
        mixed[i] = Math.max(-32768, Math.min(32767, mixedVal));
        offset++;
    }
    return { mixed, newOffset: offset };
}

// --- POST-CALL DYNAMIC AUTOMATION FUNCTION ---
async function sendTwilioSMS(businessId, to) {
    if (!businessId || !to) return;
    try {
        const { data: bData } = await supabase.from('businesses')
            .select('twilio_account_sid, twilio_auth_token, twilio_number, sms_automation_enabled, sms_automation_text, sms_automation_media_url')
            .eq('id', businessId)
            .limit(1);

        if (!bData || bData.length === 0) return;
        const b = bData[0];

        if (!b.sms_automation_enabled || !b.sms_automation_text || b.sms_automation_text.trim() === '') {
            console.log(`[SYS] Automation disabled or empty text. SMS aborted.`);
            return;
        }

        const credentials = Buffer.from(`${b.twilio_account_sid.trim()}:${b.twilio_auth_token.trim()}`).toString('base64');
        
        const payload = new URLSearchParams({
            To: to,
            From: b.twilio_number.trim(),
            Body: b.sms_automation_text.trim()
        });

        if (b.sms_automation_media_url && b.sms_automation_media_url.trim() !== '') {
            payload.append('MediaUrl', b.sms_automation_media_url.trim());
        }

        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${b.twilio_account_sid.trim()}/Messages.json`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: payload.toString()
        });

        const resData = await response.json();
        if (resData.sid) {
            console.log(`[SYS] Automated Post-Call SMS successfully sent to ${to}. SID: ${resData.sid}`);
        } else {
            console.error(`[SYS] Twilio SMS Failure. Reason:`, resData.message);
        }
    } catch (err) {
        console.error('[SYS] Failed to send automated SMS:', err.message);
    }
}

async function createCallRecord({ businessId, contactId, campaignId, targetNumber, direction, twilioCallSid, maxDurationLimit }) {
    const { data, error } = await supabase
        .from('calls')
        .insert({
            business_id: businessId || null,
            contact_id: contactId || null,
            campaign_id: campaignId || null,
            target_number: targetNumber || null,
            direction,
            status: 'initiated', // Ensure it starts active
            twilio_call_sid: twilioCallSid || null,
            max_duration_limit: maxDurationLimit || 120,
            started_at: new Date().toISOString()
        })
        .select()
        .limit(1);
    if (error) { console.error('Error creating call record:', error.message); return null; }
    return data && data.length > 0 ? data[0].id : null;
}

async function updateCallRecord(callId, { status, callerTranscript, geminiTranscript, durationSeconds, summary, creditsUsed }) {
    if (!callId) return;
    const { error } = await supabase
        .from('calls')
        .update({
            status,
            caller_transcript: callerTranscript || null,
            gemini_transcript: geminiTranscript || null,
            duration_seconds: durationSeconds || 0,
            credits_used: creditsUsed || 0,
            summary: summary || null,
            ended_at: new Date().toISOString()
        })
        .eq('id', callId);
    if (error) console.error('Error updating call record:', error.message);
}

async function incrementBusinessCallCount(businessId) {
    if (!businessId) return;
    const { error } = await supabase.rpc('increment_calls_used', { business_id_input: businessId });
    if (error) console.error('Error incrementing call count:', error.message);
}

async function getAgentById(agentId) {
    if (!agentId) return null;
    const { data, error } = await supabase.from('agents').select('*').eq('id', agentId).limit(1);
    if (error) return null;
    return data && data.length > 0 ? data[0] : null;
}

async function getGroupById(groupId) {
    if (!groupId) return null;
    const { data, error } = await supabase
        .from('ai_groups')
        .select(`id, name, routing_conditions, primary_agent_id, group_members(agent_id)`)
        .eq('id', groupId)
        .limit(1);
    if (error) return null;
    return data && data.length > 0 ? data[0] : null;
}

async function getActiveCallSettings(businessId, campaignId) {
    if (!businessId) return null;
    const { data: biz, error } = await supabase
        .from('businesses')
        .select('live_call_tasks_prompt')
        .eq('id', businessId)
        .limit(1);

    if (error || !biz || biz.length === 0) return null;
    return { liveCallTasksPrompt: biz[0].live_call_tasks_prompt || '' };
}

async function generateCallSummary(callerTranscript, geminiTranscript) {
    if (!callerTranscript && !geminiTranscript) return null;
    try {
        const fullTranscript = [callerTranscript, geminiTranscript].filter(Boolean).join('\n').trim();
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `Summarize this phone call in 3-4 bullet points. Cover what was discussed, decisions made, and next steps. Be concise and professional. 

IMPORTANT INSTRUCTION FOR SENTIMENT TAGGING:
At the very end of your response, on a new line, you MUST evaluate the human caller's sentiment and intent based strictly on the following rules:
- If the user is angry, frustrated, hangs up, declines, or shows no interest, use exactly: [not interested]
- If the user explicitly agrees, wants to buy, or is highly positive, use exactly: [interested]
- If the user asks for a callback, requests more information, or is unsure but polite, use exactly: [likelyinterested]
- If you cannot determine the sentiment, use exactly: [unknown]

You MUST append EXACTLY ONE of these tags at the very end of your text response. Do not include any other text after the tag.

Transcript:
${fullTranscript}` }] }],
                    generationConfig: { maxOutputTokens: 300, temperature: 0.2 }
                })
            }
        );
        const data = await response.json();
        if (data.error) return null;
        return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (err) {
        return null;
    }
}

fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio + Gemini Live API Media Stream Server is running!' });
});

fastify.post('/call-status', async (request, reply) => {
    const { CallSid, CallStatus, CallDuration } = request.body;
    const { businessId, campaignId, targetNumber, contactId } = request.query;

    console.log(`[TWILIO STATUS PING] Call ${CallSid} received status: ${CallStatus}`);

    const { data: existingCall } = await supabase
        .from('calls')
        .select('id, status')
        .eq('twilio_call_sid', CallSid)
        .limit(1);

    if (existingCall && existingCall.length > 0) {
        if (['busy', 'no-answer', 'canceled', 'failed', 'completed'].includes(CallStatus)) {
            let updatePayload = { 
                status: CallStatus,
                ended_at: new Date().toISOString()
            };
            if (CallDuration) {
                updatePayload.duration_seconds = parseInt(CallDuration, 10);
                updatePayload.credits_used = Math.ceil(updatePayload.duration_seconds / 60);
            }

            await supabase.from('calls').update(updatePayload).eq('id', existingCall[0].id);
        }
    } else {
        if (['busy', 'no-answer', 'canceled', 'failed', 'completed'].includes(CallStatus)) {
            let cId = campaignId;
            if (!cId || cId === 'null' || cId === 'undefined') cId = null;

            await supabase.from('calls').insert({
                business_id: businessId || null,
                contact_id: contactId || null,
                campaign_id: cId,
                target_number: targetNumber || null,
                direction: 'outbound',
                status: CallStatus, 
                twilio_call_sid: CallSid,
                duration_seconds: CallDuration ? parseInt(CallDuration, 10) : 0,
                credits_used: CallDuration ? Math.ceil(parseInt(CallDuration, 10) / 60) : 0,
                started_at: new Date().toISOString(),
                ended_at: new Date().toISOString()
            });
        }
    }

    reply.send({ received: true });
});

fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream">
            <Parameter name="businessId" value="${request.query.businessId || ''}" />
            <Parameter name="contactId" value="${request.query.contactId || ''}" />
            <Parameter name="campaignId" value="${request.query.campaignId || ''}" />
            <Parameter name="targetNumber" value="${request.query.targetNumber || ''}" />
            <Parameter name="direction" value="${request.query.direction || 'inbound'}" />
            <Parameter name="agentId" value="${request.query.agentId || ''}" />
            <Parameter name="groupId" value="${request.query.groupId || ''}" />
            <Parameter name="maxDuration" value="${request.query.maxDuration || '120'}" />
        </Stream>
    </Connect>
</Response>`;
    reply.type('text/xml').send(twimlResponse);
});

fastify.post('/make-call', async (request, reply) => {
    const { to, businessId, contactId, agentId, groupId, campaignId, maxDuration } = request.body;
    if (!to) return reply.status(400).send({ error: 'Missing "to" phone number' });
    if (!businessId) return reply.status(400).send({ error: 'Missing business ID' });

    const { data: businessData, error: dbError } = await supabase
        .from('businesses')
        .select('twilio_account_sid, twilio_auth_token, twilio_number, credits_balance')
        .eq('id', businessId)
        .limit(1);

    if (dbError || !businessData || businessData.length === 0) {
        return reply.status(500).send({ error: 'Failed to retrieve business profile.' });
    }
    const bData = businessData[0];

    if (bData.credits_balance <= 0) {
        return reply.status(402).send({ error: 'Insufficient credits. Please top up your balance.' });
    }

    if (!bData.twilio_account_sid || !bData.twilio_auth_token || !bData.twilio_number) {
        return reply.status(400).send({ error: 'Twilio credentials not configured. Please update your Settings.' });
    }

    const userTwilioSid = bData.twilio_account_sid.trim();
    const userTwilioAuth = bData.twilio_auth_token.trim();
    const userTwilioNumber = bData.twilio_number.trim();

    try {
        const credentials = Buffer.from(`${userTwilioSid}:${userTwilioAuth}`).toString('base64');
        
        const webhookUrl = new URL(`https://${request.headers.host}/incoming-call`);
        webhookUrl.searchParams.set('businessId', businessId);
        webhookUrl.searchParams.set('targetNumber', to);
        if (contactId) webhookUrl.searchParams.set('contactId', contactId);
        if (agentId) webhookUrl.searchParams.set('agentId', agentId);
        if (groupId) webhookUrl.searchParams.set('groupId', groupId);
        if (campaignId) webhookUrl.searchParams.set('campaignId', campaignId);
        webhookUrl.searchParams.set('maxDuration', maxDuration || '120');
        webhookUrl.searchParams.set('direction', 'outbound');

        const statusCallbackUrl = new URL(`https://${request.headers.host}/call-status`);
        statusCallbackUrl.searchParams.set('businessId', businessId);
        statusCallbackUrl.searchParams.set('targetNumber', to);
        if (campaignId) statusCallbackUrl.searchParams.set('campaignId', campaignId);
        if (contactId) statusCallbackUrl.searchParams.set('contactId', contactId);

        const response = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${userTwilioSid}/Calls.json`,
            {
                method: 'POST',
                headers: { 
                    'Authorization': `Basic ${credentials}`, 
                    'Content-Type': 'application/x-www-form-urlencoded' 
                },
                body: new URLSearchParams({ 
                    To: to, 
                    From: userTwilioNumber, 
                    Url: webhookUrl.toString(),
                    StatusCallback: statusCallbackUrl.toString(),
                    StatusCallbackMethod: 'POST',
                    StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'].join(' ')
                }).toString()
            }
        );

        const data = await response.json();
        if (data.sid) {
            let cId = campaignId;
            if (!cId || cId === 'null' || cId === 'undefined') cId = null;

            const { data: duplicateCheck } = await supabase.from('calls').select('id').eq('twilio_call_sid', data.sid).limit(1);
            if (!duplicateCheck || duplicateCheck.length === 0) {
                await supabase.from('calls').insert({
                    business_id: businessId || null,
                    contact_id: contactId || null,
                    campaign_id: cId,
                    target_number: to,
                    direction: 'outbound',
                    status: 'initiated', 
                    twilio_call_sid: data.sid,
                    duration_seconds: 0,
                    credits_used: 0,
                    started_at: new Date().toISOString()
                });
            }

            reply.send({ success: true, callSid: data.sid, to });
        } else {
            reply.status(500).send({ success: false, error: data.message || 'Failed to initiate call via your Twilio account' });
        }
    } catch (err) {
        reply.status(500).send({ success: false, error: err.message });
    }
});

fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        
        let geminiWs = null; 
        let geminiReady = false;
        let isTransferring = false;
        let isDisconnecting = false; 
        let isTransferContextActive = false;

        let streamSid = null;
        let latestMediaTimestamp = 0;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let lastAssistantMark = null;
        let callEnded = false;
        let callTimer = null;
        
        let accumulatedText = '';
        let accumulatedTranscription = '';
        
        let soundPumpInterval = null;  
        let isSpeaking = false;        
        let soundSamples = null;   
        let soundOffset = 0;       
        let soundVolume = 30;      

        let callId = null;
        let businessId = null;
        let contactId = null;
        let campaignId = null;
        let targetNumber = null;
        let direction = 'inbound';
        let callStartTime = null;
        let callerTranscriptParts = [];
        let geminiTranscriptParts = [];

        let isGroupCall = false;
        let groupRoutingConditions = '';
        let availableAgents = [];
        let currentAgent = null;

        let liveCallTasksPrompt = '';
        let capturedExtractedData = null;

        const endCall = async (reason = 'timeout') => {
            if (callEnded) return;

            if (reason === 'timeout') {
                if (geminiWs && geminiWs.readyState === WebSocket.OPEN && geminiReady) {
                    console.log(`[SYS] Max Call Duration Reached. Injecting timeout instruction...`);
                    const goodbyeMsg = {
                        client_content: {
                            turns: [{ role: 'user', parts: [{ text: '[INTERNAL INSTRUCTION - DO NOT READ ALOUD] The maximum call time limit has been reached. End the call now naturally as an Indian caller who suddenly needs to leave. Keep it very short, casual, and human. Do not mention time limits. Append [END_CALL] at the end of your text response.' }] }],
                            turn_complete: true
                        }
                    };
                    geminiWs.send(JSON.stringify(goodbyeMsg));
                } else {
                    endCall('forced_timeout'); 
                }
                return; 
            }

            console.log(`[SYS] Physically closing call sockets. Reason: ${reason}`);
            callEnded = true;
            isDisconnecting = true;
            
            if (callTimer) { clearTimeout(callTimer); callTimer = null; }
            
            stopSoundPump();
            await saveCallToDatabase(reason);
            
            if (connection.readyState === WebSocket.OPEN) connection.close();
            if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
        };

        const saveCallToDatabase = async (reason) => {
            if (!callId) return;
            const durationSeconds = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
            const callerTranscript = callerTranscriptParts.join('\n') || null;
            const geminiTranscript = geminiTranscriptParts.join('\n') || null;

            const summary = await generateCallSummary(callerTranscript, geminiTranscript);
            const minutesUsed = Math.ceil(durationSeconds / 60);

            // --- SMS AUTOMATION CHECK AFTER SUMMARY IS GENERATED ---
            if (summary && targetNumber) {
                const lowerSummary = summary.toLowerCase();
                if (lowerSummary.includes('[interested]') || lowerSummary.includes('[likelyinterested]')) {
                    console.log(`[SYS] Post-Call Analysis: Positive intent detected. Triggering SMS to ${targetNumber}...`);
                    await sendTwilioSMS(businessId, targetNumber);
                }
            }

            await updateCallRecord(callId, { 
                status: 'completed', 
                callerTranscript, 
                geminiTranscript, 
                durationSeconds, 
                summary,
                creditsUsed: minutesUsed 
            });

            await incrementBusinessCallCount(businessId);

            if (minutesUsed > 0) {
                await supabase.rpc('subtract_credits', { 
                    business_id_input: businessId, 
                    amount_to_subtract: minutesUsed 
                });
            }
        };

        const startSoundPump = () => {
            if (!soundSamples || soundPumpInterval) return;
            const CHUNK_SIZE_8K = 160; 
            const CHUNK_SIZE_24K = 480;

            soundPumpInterval = setInterval(() => {
                if (!streamSid || callEnded || isTransferring || isDisconnecting) return;
                if (isSpeaking) return; 

                try {
                    const chunk = new Int16Array(CHUNK_SIZE_24K);
                    const vol = soundVolume / 100;

                    for (let i = 0; i < CHUNK_SIZE_24K; i++) {
                        chunk[i] = Math.round(soundSamples[soundOffset % soundSamples.length] * vol);
                        soundOffset++;
                    }

                    const mulaw8k = Buffer.alloc(CHUNK_SIZE_8K);
                    for (let i = 0; i < CHUNK_SIZE_8K; i++) {
                        mulaw8k[i] = linearToMulaw(Math.max(-32768, Math.min(32767, chunk[i * 3])));
                    }

                    const payload = mulaw8k.toString('base64');
                    if (connection.readyState === WebSocket.OPEN) {
                        connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
                    }
                } catch (err) {
                    console.error('Sound pump error:', err.message);
                }
            }, 20);
        };

        const stopSoundPump = () => {
            if (soundPumpInterval) {
                clearInterval(soundPumpInterval);
                soundPumpInterval = null;
            }
        };

        const handleInterruption = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                connection.send(JSON.stringify({ event: 'clear', streamSid }));
                markQueue = [];
                lastAssistantMark = null;
                responseStartTimestampTwilio = null;
            }
        };

        const sendMark = () => {
            if (streamSid) {
                connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
                markQueue.push('responsePart');
                lastAssistantMark = 'responsePart';
            }
        };

        const executeHotSwap = (targetId) => {
            const targetAgent = availableAgents.find(a => String(a.id).trim() === targetId.trim());
            
            if (!targetAgent) {
                console.error(`[HOT SWAP FAIL] Invalid Target ID: ${targetId}. Continuing with current agent.`);
                isTransferring = false;
                return;
            }
            if (currentAgent && targetAgent.id === currentAgent.id) {
                console.log(`[SYS] AI attempted to transfer to itself. Ignoring.`);
                isTransferring = false;
                return;
            }

            console.log(`[HOT SWAP] Instantly swapping from ${currentAgent?.name} to ${targetAgent.name}`);

            if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                geminiWs.close();
            }

            isSpeaking = false;
            markQueue = [];
            accumulatedText = '';
            accumulatedTranscription = '';
            currentAgent = targetAgent;

            if (targetAgent.background_sound && targetAgent.background_sound !== 'none') {
                soundVolume = targetAgent.sound_volume ?? 30;
                loadSoundPCM(targetAgent.background_sound).then(s => {
                    soundSamples = s;
                    startSoundPump();
                });
            } else {
                stopSoundPump();
                soundSamples = null;
            }

            const history = callerTranscriptParts.slice(-10).join('\n') || "No previous context.";
            connectGemini(history);
        };

        const connectGemini = (transferContext = null) => {
            geminiReady = false;
            geminiWs = new WebSocket(GEMINI_WS_URL);

            geminiWs.on('error', (err) => console.error("Gemini WebSocket Error:", err));

            geminiWs.on('open', () => {
                let finalPrompt = currentAgent ? currentAgent.prompt : SYSTEM_MESSAGE;
                let finalVoice = currentAgent ? currentAgent.voice : VOICE;

                finalPrompt += `\n\n=== CALL CONTEXT & AWARENESS ===\n`;
                finalPrompt += `- CALL DIRECTION: This is an ${direction.toUpperCase()} call.\n`;
                if (currentAgent) {
                    finalPrompt += `- YOUR IDENTITY: You are currently acting as ${currentAgent.name}.\n`;
                }

                if (isGroupCall && availableAgents.length > 0) {
                    finalPrompt += `\n=== MULTI-AGENT ROUTING RULES ===\n${groupRoutingConditions}\n\nIMPORTANT INSTRUCTION: If the user's request matches your routing rules to transfer, you MUST transfer the call. \nCRITICAL IDENTITY RULE: You are currently acting as ${currentAgent ? currentAgent.name : 'this agent'}. You CANNOT transfer the call to yourself. If the user asks for you or your department, handle it directly.\n\nTo transfer to a DIFFERENT agent, simply say a brief transition sentence (e.g., "I'll transfer you now, please hold.") and append EXACTLY this tag at the very end of your text response: [TRANSFER_TO_agent_id]\n\nAVAILABLE AGENTS & EXACT TAGS TO USE:\n`;
                    let hasOtherAgents = false;
                    availableAgents.forEach(a => {
                        if (!currentAgent || String(a.id) !== String(currentAgent.id)) {
                            finalPrompt += `- To transfer to ${a.name}, use tag: [TRANSFER_TO_${a.id}]\n`;
                            hasOtherAgents = true;
                        }
                    });
                    if (!hasOtherAgents) { finalPrompt += `- (No other agents currently available to transfer to)\n`; }
                }

                finalPrompt += `\n\n=== ADVANCED ADAPTIVE BEHAVIOR SETTINGS ===
1. ACOUSTIC MORPHING: If the user shows strong buying signals or interest, silently append exactly [SHIFT_BG: office] at the end of your response to move them to a quiet closing environment. If they are stressed or angry, append exactly [SHIFT_BG: nature].
2. CONVERSATIONAL MIRRORING: Analyze the user's tone. If they are speaking fast or seem like a high-energy executive, silently append exactly [VIBE: FAST] at the end of your response. If they are slow, hesitant, or frustrated, append exactly [VIBE: EMPATHIC].`;

                finalPrompt += `\n\nAdditionally follow these natural conversation rules:\n- Use natural fillers: "hmm...", "uh...", "okay..."\n- Keep responses VERY SHORT — 1-2 sentences max\n- If user is silent: "hello... are you there?"\n- If user wants to end call: say a warm goodbye and append [END_CALL] at the very end of your text response\n- The [END_CALL] tag is never spoken — it is only a signal`;
                
                if (liveCallTasksPrompt) {
                    finalPrompt += `\n\n=== SPECIAL USER-DEFINED LIVE ACTIONS ===\nYou must strictly fulfill these tasks during the call:\n${liveCallTasksPrompt}\n\nIf you successfully extract or satisfy the target information requested above (such as an email address, name, or appointment confirmation), you must cleanly append a structured data tag to your text response exactly like this example format: [EXTRACTED_DATA: email=user@domain.com, name=John]\nDo not read this bracket data block out loud to the caller.`;
                }

                const setupMsg = {
                    setup: {
                        model: `models/${MODEL}`,
                        generation_config: {
                            response_modalities: ['AUDIO'],
                            speech_config: { voice_config: { prebuilt_voice_config: { voice_name: finalVoice } } }
                        },
                        input_audio_transcription: {},
                        output_audio_transcription: {},
                        system_instruction: { parts: [{ text: finalPrompt }] }
                    }
                };

                if (transferContext) {
                    isTransferContextActive = true;
                }

                geminiWs.send(JSON.stringify(setupMsg));
            });

            geminiWs.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (msg.setupComplete !== undefined) {
                        geminiReady = true;
                        isTransferring = false;
                        
                        if (isTransferContextActive) {
                            const transferMsg = {
                                client_content: {
                                    turns: [{ role: 'user', parts: [{ text: `[INTERNAL SYSTEM MESSAGE] You just received a transferred phone call. Here is the recent conversation transcript:\n\n${transferContext}\n\nAcknowledge the transfer naturally based on your persona and continue the conversation out loud.` }] }],
                                    turn_complete: true
                                }
                            };
                            geminiWs.send(JSON.stringify(transferMsg));
                            isTransferContextActive = false;
                        } else {
                            let greetingText = direction === 'outbound' 
                                ? '[INTERNAL SYSTEM: The call just connected. YOU called the user (OUTBOUND). Greet them naturally, state who you are, and immediately say why you are calling based on your persona. DO NOT say "how may I help you?". Keep it very brief.]'
                                : '[INTERNAL SYSTEM: The call just connected. The user called YOU (INBOUND). Greet them with a short, friendly welcome and ask how you can help.]';
                            
                            geminiWs.send(JSON.stringify({
                                client_content: { turns: [{ role: 'user', parts: [{ text: greetingText }] }], turn_complete: true }
                            }));
                        }
                        return;
                    }

                    if (msg.serverContent) {
                        const sc = msg.serverContent;

                        if (sc.interrupted && !isTransferring && !isDisconnecting) {
                            handleInterruption();
                            return;
                        }

                        if (sc.inputTranscription?.text) {
                            callerTranscriptParts.push(`Caller: ${sc.inputTranscription.text}`);
                        }

                        if (sc.outputTranscription?.text) {
                            let incomingText = sc.outputTranscription.text;

                            incomingText = incomingText.replace(/\[SHIFT_BG:.*?\]/g, '').replace(/\[VIBE:.*?\]/g, '');

                            accumulatedTranscription += incomingText;
                            geminiTranscriptParts.push(`AI (${currentAgent?.name || 'System'}): ${incomingText}`);

                            const dataMatch = accumulatedTranscription.match(/\[EXTRACTED_DATA:\s*([^\]]+)\]/i);
                            if (dataMatch) {
                                capturedExtractedData = dataMatch[1].trim();
                                console.log(`[SYS] Target Captured (Transcription): ${capturedExtractedData}`);
                            }

                            if (accumulatedTranscription.includes('[END_CALL]') && !isDisconnecting) {
                                console.log(`[SYS] Caught END_CALL Tag in transcription. Initiating socket disconnect in 1.5s...`);
                                isDisconnecting = true;
                                setTimeout(() => { endCall('user_intent'); }, 1500); 
                            }

                            const tagMatch = accumulatedTranscription.match(/\[TRANSFER_TO_([a-zA-Z0-9-]+)\]/);
                            if (tagMatch && !isTransferring) {
                                isTransferring = true;
                                const targetId = tagMatch[1];
                                console.log(`[SYS] Caught TRANSFER_TO tag for ID: ${targetId} in transcription. Triggering swap in 1.5s...`);
                                setTimeout(() => { executeHotSwap(targetId); }, 1500);
                            }
                        }

                        if (sc.modelTurn?.parts) {
                            for (const part of sc.modelTurn.parts) {

                                if (part.text) {
                                    accumulatedText += part.text;

                                    const dataMatchText = accumulatedText.match(/\[EXTRACTED_DATA:\s*([^\]]+)\]/i);
                                    if (dataMatchText) {
                                        capturedExtractedData = dataMatchText[1].trim();
                                        console.log(`[SYS] Target Captured (Text): ${capturedExtractedData}`);
                                    }
                                    
                                    if (accumulatedText.includes('[END_CALL]') && !isDisconnecting) {
                                        console.log(`[SYS] Caught END_CALL Tag in text parts. Initiating socket disconnect in 1.5s...`);
                                        isDisconnecting = true;
                                        setTimeout(() => { endCall('user_intent'); }, 1500); 
                                    }

                                    const tagMatch = accumulatedText.match(/\[TRANSFER_TO_([a-zA-Z0-9-]+)\]/);
                                    if (tagMatch && !isTransferring) {
                                        isTransferring = true;
                                        const targetId = tagMatch[1];
                                        console.log(`[SYS] Caught TRANSFER_TO tag for ID: ${targetId} in text parts. Triggering swap in 1.5s...`);
                                        setTimeout(() => { executeHotSwap(targetId); }, 1500);
                                    }

                                    // --- ADVANCED ADAPTIVE DYNAMIC TAG CATCHERS ---
                                    
                                    if (accumulatedText.includes('[SHIFT_BG: office]')) {
                                        console.log(`[SYS] Dynamic Audio Morph Triggered: Shifting to 'office' environment.`);
                                        loadSoundPCM('office').then(s => { soundSamples = s; });
                                        accumulatedText = accumulatedText.replace('[SHIFT_BG: office]', '');
                                    }

                                    if (accumulatedText.includes('[SHIFT_BG: nature]')) {
                                        console.log(`[SYS] Dynamic Audio Morph Triggered: Shifting to 'nature' environment.`);
                                        loadSoundPCM('nature').then(s => { soundSamples = s; });
                                        accumulatedText = accumulatedText.replace('[SHIFT_BG: nature]', '');
                                    }

                                    if (accumulatedText.includes('[VIBE: FAST]')) {
                                        console.log(`[SYS] Conversational Mirroring: Shifting to FAST/HIGH-ENERGY mode.`);
                                        geminiWs.send(JSON.stringify({ client_content: { turns: [{ role: 'user', parts: [{ text: '[INTERNAL SYSTEM COMMAND: The user is high-energy. Speak faster, be brief, and use high-energy power words. Do not acknowledge this command aloud.]' }] }], turn_complete: true } }));
                                        accumulatedText = accumulatedText.replace('[VIBE: FAST]', '');
                                    }

                                    if (accumulatedText.includes('[VIBE: EMPATHIC]')) {
                                        console.log(`[SYS] Conversational Mirroring: Shifting to EMPATHIC mode.`);
                                        geminiWs.send(JSON.stringify({ client_content: { turns: [{ role: 'user', parts: [{ text: '[INTERNAL SYSTEM COMMAND: The user is hesitant or frustrated. Slow down your speaking rate significantly, use a warm, empathetic, and hyper-polite tone. Do not acknowledge this command aloud.]' }] }], turn_complete: true } }));
                                        accumulatedText = accumulatedText.replace('[VIBE: EMPATHIC]', '');
                                    }
                                }

                                if (part.inlineData?.data) {
                                    const mimeType = part.inlineData.mimeType || '';
                                    if (mimeType.startsWith('audio/pcm') || mimeType === 'audio/pcm;rate=24000') {
                                        isSpeaking = true;
                                        let audioBase64 = part.inlineData.data;

                                        if (soundSamples && soundSamples.length > 0) {
                                            try {
                                                const pcmBuf = Buffer.from(audioBase64, 'base64');
                                                const geminiPcm = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength / 2);
                                                const { mixed, newOffset } = mixSoundIntoAudio(geminiPcm, soundSamples, soundOffset, soundVolume);
                                                soundOffset = newOffset;
                                                audioBase64 = Buffer.from(mixed.buffer).toString('base64');
                                            } catch (mixErr) {
                                                console.error('Sound mixing error:', mixErr.message);
                                            }
                                        }

                                        const mulawPayload = pcm16Base64ToMulawBase64(audioBase64);
                                        connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: mulawPayload } }));

                                        if (!responseStartTimestampTwilio) responseStartTimestampTwilio = latestMediaTimestamp;
                                        sendMark();
                                    }
                                }
                            }
                        }

                        if (sc.turnComplete) {
                            isSpeaking = false;
                            if (!isTransferring && !isDisconnecting) {
                                accumulatedText = ''; 
                                accumulatedTranscription = '';
                            }
                        }
                    }
                } catch (err) {
                    console.error('Error processing Gemini message:', err);
                }
            });
        };

        connection.on('message', async (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'start':
                        streamSid = data.start.streamSid;
                        callStartTime = Date.now();

                        const params = data.start.customParameters || {};
                        businessId = params.businessId || null;
                        contactId = params.contactId || null;
                        direction = params.direction || 'inbound';
                        const agentId = params.agentId || null;
                        const groupId = params.groupId || null;
                        
                        campaignId = params.campaignId;
                        if (!campaignId || campaignId === 'null' || campaignId === 'undefined') {
                            campaignId = null;
                        }
                        
                        targetNumber = params.targetNumber;
                        if (!targetNumber || targetNumber === 'null' || targetNumber === 'undefined') {
                            targetNumber = null;
                        }

                        const maxDurationSec = parseInt(params.maxDuration || '120', 10);

                        if (businessId) {
                            const activeSettings = await getActiveCallSettings(businessId, campaignId);
                            if (activeSettings) {
                                liveCallTasksPrompt = activeSettings.liveCallTasksPrompt;
                            }
                        }

                        if (groupId) {
                            isGroupCall = true;
                            const groupData = await getGroupById(groupId);
                            
                            if (groupData) {
                                groupRoutingConditions = groupData.routing_conditions;
                                
                                const pAgent = await getAgentById(groupData.primary_agent_id);
                                if (pAgent) {
                                    currentAgent = pAgent;
                                    availableAgents.push(pAgent);
                                }
                                
                                for (const member of (groupData.group_members || [])) {
                                    if (member.agent_id !== groupData.primary_agent_id) {
                                        const bAgent = await getAgentById(member.agent_id);
                                        if (bAgent) availableAgents.push(bAgent);
                                    }
                                }
                            }
                        } else if (agentId) {
                            currentAgent = await getAgentById(agentId);
                        }

                        if (currentAgent && currentAgent.background_sound && currentAgent.background_sound !== 'none') {
                            soundVolume = currentAgent.sound_volume ?? 30;
                            const sSamples = await loadSoundPCM(currentAgent.background_sound);
                            if (sSamples) {
                                soundSamples = sSamples;
                                startSoundPump();
                            }
                        }

                        connectGemini();

                        const { data: existingRecord } = await supabase.from('calls').select('id').eq('twilio_call_sid', streamSid).limit(1);
                        if (existingRecord && existingRecord.length > 0) {
                            callId = existingRecord[0].id;
                            await supabase.from('calls').update({ status: 'in-progress' }).eq('id', callId);
                        } else {
                            callId = await createCallRecord({ 
                                businessId, contactId, campaignId, targetNumber,
                                direction, twilioCallSid: streamSid, maxDurationLimit: maxDurationSec 
                            });
                        }
                        
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;

                        callTimer = setTimeout(() => {
                            endCall('timeout');
                        }, maxDurationSec * 1000);
                        break;

                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (geminiWs && geminiWs.readyState === WebSocket.OPEN && geminiReady && !isTransferring && !isDisconnecting) {
                            const pcm16Payload = mulawBase64ToPcm16Base64(data.media.payload);
                            geminiWs.send(JSON.stringify({
                                realtime_input: { media_chunks: [{ data: pcm16Payload, mime_type: 'audio/pcm;rate=16000' }] }
                            }));
                        }
                        break;

                    case 'mark':
                        if (markQueue.length > 0) markQueue.shift();
                        break;

                    case 'stop':
                        endCall('caller_hung_up');
                        break;
                }
            } catch (err) {
                console.error('Error parsing Twilio message:', err);
            }
        });

        connection.on('close', () => {
            stopSoundPump();
            endCall('connection_closed');
        });
    });
});

fastify.post('/verify-payment', async (request, reply) => {
    const { paymentId, businessId, creditsToAdd } = request.body;

    if (!paymentId || !businessId || !creditsToAdd) {
        return reply.status(400).send({ success: false, error: 'Missing required fields' });
    }

    try {
        const credentials = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
        const response = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Basic ${credentials}` }
        });
        const rzpData = await response.json();

        if (rzpData.status === 'captured' || rzpData.status === 'authorized') {
            const { error } = await supabase.rpc('add_credits', {
                business_id_input: businessId,
                amount_to_add: creditsToAdd
            });

            if (error) throw error;
            return reply.send({ success: true, message: 'Payment verified and credits added.' });
        } else {
            return reply.status(400).send({ success: false, error: 'Payment not captured by Razorpay.' });
        }
    } catch (err) {
        console.error('Payment Verification Error:', err);
        return reply.status(500).send({ success: false, error: err.message });
    }
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) { console.error(err); process.exit(1); }
    console.log(`Server is listening on port ${PORT}`);
});