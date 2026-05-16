# 🎙️ VaaniAI Backend - Complete Project Analysis

## 📋 Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture Overview](#architecture-overview)
3. [Technology Stack](#technology-stack)
4. [Core Components](#core-components)
5. [Database Models](#database-models)
6. [API Endpoints](#api-endpoints)
7. [Services](#services)
8. [WebSocket & Real-time Features](#websocket--real-time-features)
9. [Voice Call Flow](#voice-call-flow)
10. [Key Features](#key-features)
11. [Middleware & Security](#middleware--security)
12. [Configuration & Deployment](#configuration--deployment)

---

## Project Overview

**VaaniAI Backend** is a comprehensive **Voice AI Platform** that enables businesses to deploy intelligent voice agents for inbound/outbound calls, campaigns, and conversations. It combines cutting-edge LLM technology, speech-to-text (STT), text-to-speech (TTS), and real-time WebSocket communication to create a fully functional voice automation system.

### Key Capabilities:
- ✅ **AI Voice Agents** - Create custom agents with specific behaviors and knowledge
- ✅ **Inbound Call Handling** - Route incoming calls to AI agents via Twilio
- ✅ **Outbound Campaigns** - Bulk call campaigns with intelligent scheduling
- ✅ **Call Flow Workflows** - Visual workflow builder for complex call scenarios
- ✅ **Speech Recognition** - Deepgram STT for 15+ languages including Indian languages
- ✅ **LLM Integration** - Support for Groq, OpenAI, Google Gemini
- ✅ **Text-to-Speech** - Multiple TTS providers (Edge TTS, ElevenLabs, Google, Azure)
- ✅ **Knowledge Base RAG** - Document-based intelligent context
- ✅ **Call Analytics** - Comprehensive call metrics, sentiment analysis, QA scoring
- ✅ **Recording & Storage** - AWS S3 integration for call recordings
- ✅ **Webhook Integration** - n8n, Zapier, and custom webhook support
- ✅ **WebRTC Support** - Browser-based voice calls

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      CLIENT LAYER                               │
│  (Web Browser / Mobile App / Phone Call via Twilio)            │
└────────────────────────────┬────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
   WebSocket            REST API             Twilio Webhooks
   (ws://:/voice)   (http://:/api/*)      (Inbound Calls)
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXPRESS.JS SERVER                             │
├─────────────────────────────────────────────────────────────────┤
│  • Request Correlation ID                                       │
│  • Rate Limiting (Global, Auth, Voice, Campaign)               │
│  • CORS & Security Headers (Helmet)                            │
│  • Error Handling & Async Handler Wrapper                      │
└────────┬─────────────────────────────────────────────────────┬──┘
         │                                                      │
         ▼                                                      ▼
   ROUTES LAYER                                          WEBSOCKET LAYER
   ├─ /api/auth                                          ├─ Voice Session
   ├─ /api/agents                                        ├─ WebRTC Session
   ├─ /api/calls
   ├─ /api/campaigns
   ├─ /api/numbers
   ├─ /api/twilio
   ├─ /api/webhooks
   └─ /api/analytics
         │
         ▼
   SERVICES LAYER
   ├─ voicePipeline.js (STT → LLM → TTS)
   ├─ callFlowEngine.js (Visual workflow)
   ├─ campaignWorker.js (Bulk calling)
   ├─ deepgramService.js (Speech recognition)
   ├─ groqService.js / geminiService.js (LLM)
   ├─ ttsService.js (Text-to-speech)
   ├─ s3Service.js (Recording storage)
   ├─ redisService.js (Caching & sessions)
   ├─ toolExecutor.js (LLM function calls)
   └─ webhookDispatcher.js (Webhook delivery)
         │
         ▼
   DATA ACCESS LAYER
   ├─ MongoDB Models
   └─ Redis Cache
```

---

## Technology Stack

### Backend Framework
- **Express.js** (4.18.2) - REST API & WebSocket server
- **Node.js** - JavaScript runtime
- **MongoDB** (via Mongoose 8.2.1) - Primary database

### Real-time Communication
- **WebSocket (ws 8.16.0)** - Real-time voice session streaming
- **Twilio SDK (5.0.4)** - Phone call handling & management

### AI & LLM
- **Groq SDK (0.5.0)** - Fast LLM inference (free models)
- **Google Gemini API** - Fallback LLM with free tier
- **OpenAI API** - Alternative LLM provider

### Speech Processing
- **Deepgram SDK (3.3.0)** - Speech-to-Text (STT)
- **Edge TTS** - Free text-to-speech (Microsoft)
- **ElevenLabs API** - Premium TTS alternative

### Infrastructure & Storage
- **AWS S3 SDK (2.1617.0)** - Call recording storage
- **Redis (4.7.1) / IORedis (5.10.1)** - Caching & session management

### Security & Utilities
- **JWT (jsonwebtoken 9.0.2)** - Authentication tokens
- **BCrypt (2.4.3)** - Password hashing
- **Helmet (7.1.0)** - HTTP security headers
- **CORS (2.8.5)** - Cross-origin support
- **Rate-limit-redis** - Distributed rate limiting

### Monitoring & Logging
- **Morgan (1.10.0)** - HTTP request logging
- **Winston (3.19.0)** - Structured logging

---

## Core Components

### 1. **Server.js** - Main Entry Point
The server initializes:
- Express app with middleware stack
- HTTP server for WebSocket upgrade handling
- Two WebSocket servers:
  - Voice session (ws://:/voice)
  - WebRTC session (ws://:/webrtc)
- MongoDB connection
- Campaign worker (background job)
- Static file serving (widget.js for embeds)

### 2. **Routes Organization**
```
routes/
├─ auth.js              → User registration, login, token refresh
├─ agents.js            → Create/read/update/delete AI agents
├─ calls.js             → Call history, call details
├─ campaigns.js         → Campaign management, call lists
├─ numbers.js           → Phone number management (Twilio)
├─ twilio.js            → Twilio webhooks (inbound, status, recording)
├─ callFlows.js         → Visual workflow builder
├─ webhooks.js          → Webhook configuration & logs
├─ voicePreview.js      → TTS preview for voice testing
├─ analytics.js         → Call metrics, sentiment, QA
├─ usage.js             → Usage tracking & billing
├─ crm.js               → CRM integration (Salesforce, HubSpot)
├─ knowledgeBase.js     → Document management for RAG
├─ storage.js           → Recording & file storage
├─ settings.js          → User settings & API keys
├─ widget.js            → Embedded widget configuration
└─ superAdmin.js        → Admin-only operations
```

---

## Database Models

### 1. **User Model**
Represents platform users with authentication and settings.

```javascript
{
  name: String,
  email: String (unique),
  password: String (bcrypt hashed),
  role: 'user' | 'admin' | 'super_admin',
  settings: {
    groqKey: String,
    openaiKey: String,
    geminiKey: String,
    deepgramKey: String,
    elevenLabsKey: String,
    twilioAccountSid: String,
    twilioAuthToken: String,
    twilioPhoneNumber: String,
    preferredLlm: String,
    preferredTts: String,
    postCallWebhookUrl: String,
    webhookSecret: String
  },
  createdAt: Date
}
```

### 2. **Agent Model**
AI agent configuration and behavior parameters.

```javascript
{
  userId: ObjectId (ref: User),
  name: String,
  systemPrompt: String,           // Agent behavior/personality
  firstMessage: String,           // Greeting message
  voice: {
    provider: 'edge-tts' | 'eleven-labs' | 'google' | 'azure',
    voiceId: String,
    speed: Number (0.5-2.0),
    pitch: Number
  },
  llm: {
    provider: 'groq' | 'openai' | 'gemini',
    model: String
  },
  temperature: Number (0-1),
  language: String,               // en, hi, ta, te, kn, ml, etc.
  maxDuration: Number,            // Max call duration in seconds
  endCallMessage: String,
  transferNumber: String,         // Phone for human handoff
  postCallActions: {
    sendSMS: Boolean,
    sendWhatsApp: Boolean,
    smsTemplate: String
  },
  tools: [{ name, description, schema }]  // Function calling
}
```

### 3. **CallLog Model**
Complete record of every call (inbound/outbound/web).

```javascript
{
  userId: ObjectId (ref: User),
  agentId: ObjectId (ref: Agent),
  agentName: String,
  fromNumber: String,
  toNumber: String,
  direction: 'inbound' | 'outbound' | 'web',
  status: 'completed' | 'failed' | 'ongoing' | 'no-answer',
  startTime: Date,
  endTime: Date,
  duration: Number,               // seconds
  transcript: [{                  // Full conversation
    role: 'user' | 'assistant',
    content: String,
    timestamp: Date
  }],
  summary: String,                // Auto-generated summary
  recordingUrl: String,           // S3 URL
  sentiment: 'positive' | 'neutral' | 'negative',
  emotion: String,
  metrics: {
    nps: Number (0-10),           // Net Promoter Score
    csat: Number (0-5),           // Customer Satisfaction
    effort: Number (0-5)          // Customer Effort Score
  },
  qa: {
    score: Number (0-100),
    grade: 'A' | 'B' | 'C' | 'D' | 'F',
    feedback: String,
    reviewer: ObjectId
  }
}
```

### 4. **Campaign Model**
Bulk outbound calling campaigns.

```javascript
{
  userId: ObjectId (ref: User),
  name: String,
  agentId: ObjectId (ref: Agent),
  status: 'draft' | 'running' | 'paused' | 'completed' | 'failed',
  numbers: [{
    phone: String,
    status: 'pending' | 'calling' | 'completed' | 'failed' | 'voicemail',
    callSid: String,
    error: String
  }],
  totalNumbers: Number,
  completedCount: Number,
  failedCount: Number,
  timestamps
}
```

### 5. **Lead Model**
CRM leads generated from calls.

```javascript
{
  userId: ObjectId (ref: User),
  agentId: ObjectId (ref: Agent),
  callLogId: ObjectId (ref: CallLog),
  name: String,
  phone: String,
  email: String,
  interest: String,               // What interested them
  status: 'Hot' | 'Warm' | 'Cold' | 'Converted' | 'Lost',
  value: String,                  // Estimated deal value
  notes: String,
  timestamps
}
```

### 6. **KnowledgeBase Model**
Documents for RAG (Retrieval-Augmented Generation).

```javascript
{
  userId: ObjectId (ref: User),
  name: String,
  description: String,
  sourceType: 'text' | 'pdf' | 'url',
  sourceUrl: String,
  fileName: String,
  fileSize: Number,
  content: String,                // Full text
  chunks: [{                      // Chunked for RAG
    text: String,
    summary: String,
    keywords: [String],
    index: Number
  }],
  status: 'processing' | 'ready' | 'error',
  timestamps
}
```

### 7. **Workflow Model**
Visual call flow builder (similar to n8n/Zapier).

```javascript
{
  userId: ObjectId (ref: User),
  name: String,
  description: String,
  nodes: [{
    id: String,
    type: 'trigger' | 'agent_speech' | 'user_intent' | 'condition' | 'action' | 'end',
    data: Object,
    position: { x, y }
  }],
  edges: [{
    id: String,
    source: String,
    target: String,
    label: String,
    condition: String
  }],
  status: 'draft' | 'active' | 'archived'
}
```

### 8. **PhoneNumber Model**
Twilio phone numbers linked to account.

```javascript
{
  userId: ObjectId (ref: User),
  phoneNumber: String,
  country: String,
  status: 'active' | 'inactive',
  purchasedAt: Date,
  expiresAt: Date,
  twilioSid: String
}
```

### 9. **Webhook Model**
User-configured webhooks for external integrations.

```javascript
{
  userId: ObjectId (ref: User),
  name: String,
  url: String,
  events: [String],               // 'call_completed', 'call_failed', etc.
  active: Boolean,
  retryPolicy: { maxAttempts, delayMs },
  headers: Object,
  secret: String                  // HMAC verification
}
```

### 10. **UsageTracker Model**
Billing and usage metrics.

```javascript
{
  userId: ObjectId (ref: User),
  month: String,
  callMinutes: Number,
  inboundMinutes: Number,
  outboundMinutes: Number,
  recordingMinutes: Number,
  smsCount: Number,
  apiCalls: Number,
  estimatedCost: Number
}
```

### Additional Models
- **BatchCall** - Group of calls for batch processing
- **CallFlow** - Saved call flow templates
- **Ticket** - Support tickets
- **UserMemory** - Persistent user/conversation memory
- **WebhookLog** - Webhook delivery history
- **WebhookLog** - Recording metadata

---

## API Endpoints

### Authentication Routes (`/api/auth`)
```
POST   /api/auth/register           → Register new user
POST   /api/auth/login              → Login, get JWT token
POST   /api/auth/refresh-token      → Refresh expired token
POST   /api/auth/logout             → Logout (invalidate token)
GET    /api/auth/me                 → Get current user profile
POST   /api/auth/change-password    → Update password
```

### Agents Routes (`/api/agents`)
```
GET    /api/agents                  → List all agents for user
POST   /api/agents                  → Create new agent
GET    /api/agents/:agentId         → Get agent details
PUT    /api/agents/:agentId         → Update agent
DELETE /api/agents/:agentId         → Delete agent
POST   /api/agents/:agentId/clone   → Duplicate agent
GET    /api/agents/:agentId/test    → Test agent with sample input
```

### Calls Routes (`/api/calls`)
```
GET    /api/calls                   → List call history
GET    /api/calls/:callId           → Get call details
POST   /api/calls                   → Initiate web call
DELETE /api/calls/:callId           → Delete call log
POST   /api/calls/:callId/score     → Submit QA score
GET    /api/calls/:callId/transcript → Get full transcript
GET    /api/calls/:callId/recording → Download recording
```

### Campaigns Routes (`/api/campaigns`)
```
GET    /api/campaigns               → List campaigns
POST   /api/campaigns               → Create campaign
GET    /api/campaigns/:campaignId   → Get campaign details
PUT    /api/campaigns/:campaignId   → Update campaign
POST   /api/campaigns/:campaignId/start  → Start campaign
POST   /api/campaigns/:campaignId/pause  → Pause campaign
POST   /api/campaigns/:campaignId/resume → Resume campaign
DELETE /api/campaigns/:campaignId   → Delete campaign
GET    /api/campaigns/:campaignId/results → Campaign results
POST   /api/campaigns/:campaignId/add-numbers → Add phone numbers
```

### Numbers Routes (`/api/numbers`)
```
GET    /api/numbers                 → List Twilio numbers
POST   /api/numbers/search          → Search available numbers
POST   /api/numbers/purchase        → Purchase Twilio number
DELETE /api/numbers/:numberId       → Release number
POST   /api/numbers/:numberId/test  → Test number with call
```

### Twilio Routes (`/api/twilio`)
```
POST   /api/twilio/inbound          → Inbound call webhook
POST   /api/twilio/gather-response  → Speech recognition response
POST   /api/twilio/outbound         → Make outbound call
POST   /api/twilio/outbound-connect → Outbound TwiML response
POST   /api/twilio/status           → Call status webhook
POST   /api/twilio/recording        → Recording webhook
GET    /api/twilio/call/:callSid    → Check call status
```

### Analytics Routes (`/api/analytics`)
```
GET    /api/analytics/summary       → High-level metrics
GET    /api/analytics/calls         → Call volume trends
GET    /api/analytics/sentiment     → Sentiment analysis
GET    /api/analytics/agents        → Agent performance
GET    /api/analytics/campaigns     → Campaign metrics
GET    /api/analytics/qascores      → QA score distribution
GET    /api/analytics/export        → Export data (CSV/JSON)
```

### WebHooks Routes (`/api/webhooks`)
```
GET    /api/webhooks                → List webhooks
POST   /api/webhooks                → Create webhook
PUT    /api/webhooks/:webhookId     → Update webhook
DELETE /api/webhooks/:webhookId     → Delete webhook
GET    /api/webhooks/:webhookId/logs → View webhook logs
POST   /api/webhooks/:webhookId/test → Test webhook
POST   /api/webhooks/:webhookId/retry → Retry failed deliveries
```

### Knowledge Base Routes (`/api/knowledgebase`)
```
GET    /api/knowledgebase           → List all documents
POST   /api/knowledgebase           → Upload document (PDF/text/URL)
GET    /api/knowledgebase/:docId    → Get document details
PUT    /api/knowledgebase/:docId    → Update document
DELETE /api/knowledgebase/:docId    → Delete document
POST   /api/knowledgebase/:docId/chunk → Re-chunk document
GET    /api/knowledgebase/search    → Search documents
```

### Settings Routes (`/api/settings`)
```
GET    /api/settings                → Get user settings
PUT    /api/settings                → Update settings
GET    /api/settings/apikeys        → List configured API keys
POST   /api/settings/apikeys        → Add API key
DELETE /api/settings/apikeys/:key   → Remove API key
```

### Voice Preview Routes (`/api/voice-preview`)
```
POST   /api/voice-preview           → Test TTS with text
GET    /api/voice-preview/voices    → List available voices
GET    /api/voice-preview/models    → List available LLM models
```

### CRM Routes (`/api/crm`)
```
GET    /api/crm/status              → Check CRM integration status
POST   /api/crm/sync                → Sync leads to CRM
GET    /api/crm/leads               → List synced leads
```

### Storage Routes (`/api/storage`)
```
GET    /api/storage/recordings      → List recordings
GET    /api/storage/recordings/:id  → Get recording metadata
DELETE /api/storage/recordings/:id  → Delete recording
POST   /api/storage/recordings/:id/download → Download recording
```

### Widget Routes (`/api/widget`)
```
GET    /api/widget/:widgetId        → Get widget config
GET    /api/widget/:widgetId/iframe → Get iframe embed code
```

### Super Admin Routes (`/api/super-admin`)
```
GET    /api/super-admin/users       → List all users
GET    /api/super-admin/stats       → Platform statistics
POST   /api/super-admin/suspend     → Suspend user account
POST   /api/super-admin/bills       → Generate billing report
```

---

## Services

### 1. **voicePipeline.js** - Main Voice Processing Engine
The core orchestrator for voice calls: STT → LLM → TTS

**Key Features:**
- Converts audio input to text (Deepgram STT)
- Builds LLM prompt from system instructions + conversation history
- Generates response using configured LLM (Groq/OpenAI/Gemini)
- Converts response to speech (TTS)
- Fallback mechanism: If Groq fails, tries alternative Groq models, then Gemini

**Key Methods:**
```javascript
async processText({ text, agent, history, memory, ragContext })
  → Processes user input through LLM → TTS pipeline

async *processAudio({ audioBuffer, agent, ... })
  → Generator function yielding TTS chunks for streaming

buildSystemPrompt(agent, memory, ragContext)
  → Constructs the LLM system prompt

getGroqFallbackModels(primaryModel)
  → Returns array of fallback LLM models

async generateGroqResponseWithFallback({ ... })
  → Tries multiple LLM models with graceful fallback
```

**Configuration:**
```
LLM_RESPONSE_CACHE_ENABLED=true
LLM_RESPONSE_CACHE_MAX=50
LLM_RESPONSE_CACHE_TTL_MS=300000
ROLLING_SUMMARY_THRESHOLD=12
ROLLING_SUMMARY_KEEP_RECENT=6
GROQ_FALLBACK_MODELS=llama-3.1-8b-instant,llama-3.3-70b-versatile
```

### 2. **callFlowEngine.js** - Visual Workflow Execution
Enables visual "node-based" call flow builder (similar to n8n).

**Supported Node Types:**
- `trigger` - Start of flow
- `speak` - Agent speaks text
- `gather` - Ask user a question, capture response
- `condition` - Branch based on variables
- `action` - Execute external action (API call, webhook)
- `end` - End call

**Key Methods:**
```javascript
initFlowState(callFlow)
  → Initialize flow execution state

*processFlowStep(session, transcript, callFlow)
  → Generator yielding TTS chunks as flow progresses

getNextNodeId(callFlow, sourceNodeId)
  → Find next connected node

replaceVariables(text, variables)
  → Replace {{variable}} placeholders
```

### 3. **campaignWorker.js** - Bulk Outbound Calling
Background worker for campaign execution.

**Features:**
- Processes up to 5 simultaneous calls (configurable)
- Intelligent delay between calls (configurable)
- Call state tracking: pending → calling → completed/failed
- Campaign statistics tracking
- Graceful failure handling

**Key Methods:**
```javascript
start()
  → Start the campaign worker

processCampaigns()
  → Main loop (runs every 10 seconds)

async makeCall(campaign, numberRecord)
  → Execute single outbound call via Twilio
```

**Configuration:**
```
MAX_CONCURRENT_CALLS=5
DELAY_BETWEEN_CALLS=2000        # milliseconds
CAMPAIGN_WORKER_INTERVAL=10000  # milliseconds
```

### 4. **deepgramService.js** - Speech-to-Text
Integrates Deepgram API for speech recognition.

**Features:**
- Support for 15+ languages including Indian languages
- Confidence scoring on transcriptions
- Punctuation and capitalization
- Custom vocabulary support
- Real-time streaming

**Key Methods:**
```javascript
async transcribe(audioBuffer, language)
  → Convert audio to text

async *streamTranscribe(audioStream, language)
  → Generator for streaming transcription
```

**Supported Languages:**
```
English: en, en-IN
Hindi: hi, hi-Latn
South Indian: ta (Tamil), te (Telugu), kn (Kannada), ml (Malayalam)
West Indian: mr (Marathi), gu (Gujarati)
East Indian: bn (Bengali)
Other: ur (Urdu), pa (Punjabi)
```

### 5. **groqService.js / geminiService.js** - LLM Providers
Generate intelligent responses using large language models.

**Groq (Fast, Free):**
- Models: `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `mixtral-8x7b-32768`
- Function calling support
- Context window: 32K tokens

**Gemini (Free tier):**
- Models: `gemini-pro`, `gemini-pro-vision`
- Fallback when Groq fails
- Context window: 30K tokens

**Key Methods:**
```javascript
async generateResponse({ messages, model, temperature, tools })
  → Get LLM response with optional tool calls

async generateWithRetry({ messages, ... }, maxRetries)
  → Retry mechanism for transient failures
```

### 6. **ttsService.js** - Text-to-Speech
Multiple TTS provider support.

**Providers:**
- **Edge TTS** (Free, Microsoft) - 140+ voices
- **ElevenLabs** (Premium) - Natural sounding
- **Google Cloud TTS** - Polished voices
- **Azure TTS** - Enterprise support

**Key Methods:**
```javascript
async synthesize(text, { provider, voiceId, speed, pitch })
  → Convert text to audio buffer

async *synthesizeStream(text, ...)
  → Generator yielding audio chunks
```

### 7. **s3Service.js** - Recording Storage
AWS S3 integration for call recordings.

**Features:**
- Auto-upload on call completion
- Presigned URL generation for downloads
- Transcript storage as JSON
- Recording metadata tracking
- List recordings by user/agent

**Key Methods:**
```javascript
async uploadRecording({ recordingBuffer, callSid, userId })
  → Upload to S3

getPresignedUrl({ key, expirySeconds })
  → Generate download link

async listRecordings(userId, agentId)
  → List user's recordings
```

### 8. **redisService.js** - Caching & Sessions
Redis for distributed caching and session management.

**Uses:**
- Session state for WebSocket connections
- Rate limiting counters
- Response caching (FAQ answers)
- Temporary data storage
- Pub/Sub for multi-server communication

**Key Methods:**
```javascript
async set(key, value, ttl)
async get(key)
async del(key)
async incr(key)
async expire(key, seconds)
```

### 9. **toolExecutor.js** - Function Calling
Executes functions called by LLM during conversation.

**Built-in Tools:**
- `search_knowledge_base` - Query RAG documents
- `check_lead_status` - Query lead information
- `create_ticket` - Create support ticket
- `send_notification` - Send SMS/Email
- `transfer_to_agent` - Transfer to human
- Custom tools defined per agent

**Key Methods:**
```javascript
async execute(toolName, toolInput, context)
  → Execute tool with validation

validateToolInput(schema, input)
  → Validate input against JSON schema
```

### 10. **webhookDispatcher.js** - Webhook Delivery
Sends webhook events to external services (n8n, Zapier, etc).

**Events:**
- `call_started` - When call begins
- `call_completed` - When call ends
- `call_failed` - On call failure
- `lead_created` - When lead is generated
- `sentiment_detected` - When sentiment changes
- `transfer_requested` - Human transfer triggered

**Features:**
- Retry mechanism with exponential backoff
- HMAC signature for security
- Request/response logging
- Event filtering per webhook

**Key Methods:**
```javascript
async dispatch(event, payload)
  → Send webhook event

async retry(webhookLogId)
  → Retry failed delivery
```

### 11. **ragService.js** - Retrieval-Augmented Generation
Enables agents to use knowledge base documents.

**Features:**
- Semantic search using embeddings
- Chunk retrieval with relevance scoring
- Context injection into LLM prompt
- Support for PDF, text, and URLs

**Key Methods:**
```javascript
async search(query, topK)
  → Find relevant document chunks

async injectContext(query, systemPrompt)
  → Augment prompt with retrieved context
```

### 12. **batchCallService.js** - Batch Processing
Handle large-scale call batches.

**Features:**
- Process thousands of calls
- Progress tracking
- Error recovery
- Parallel execution with concurrency limits

### 13. **dtmfService.js** - DTMF Handling
Dual-tone multi-frequency (touch-tone) input processing.

**Features:**
- Capture phone keypad input
- Navigate IVR menus
- Numeric input validation

### 14. **notificationService.js** - Alerts & Notifications
Send SMS, Email, WhatsApp notifications.

**Channels:**
- SMS (Twilio)
- Email
- WhatsApp (Twilio)
- Webhooks
- In-app notifications

---

## WebSocket & Real-time Features

### Voice Session WebSocket (`ws://localhost:5000/voice`)

**Connection Flow:**
```javascript
1. Client connects to /voice
2. Server validates session
3. Client sends initial message with agentId
4. Server loads agent + system prompt
5. Audio streaming begins:
   - Client sends audio chunks
   - Server transcribes → LLM → TTS
   - Server sends TTS audio back in real-time
```

**Message Protocol:**

**Client → Server:**
```javascript
{
  type: 'init',
  agentId: 'agent123',
  sessionId: 'optional_session_id'
}

{
  type: 'audio',
  data: Uint8Array,           // Audio chunk (PCM 16-bit)
  sampleRate: 16000
}

{
  type: 'end'
}
```

**Server → Client:**
```javascript
{
  type: 'ready'
}

{
  type: 'audio',
  data: Uint8Array,           // TTS audio
  isFinal: false
}

{
  type: 'transcript',
  text: 'What is your name?',
  role: 'assistant'
}

{
  type: 'summary',
  transcript: [...],
  duration: 120,
  sentiment: 'positive'
}
```

**Key Files:**
- [websocket/voiceSession.js](websocket/voiceSession.js) - Voice session handler
- [websocket/webrtcSession.js](websocket/webrtcSession.js) - WebRTC browser-to-browser

---

## Voice Call Flow

### Inbound Call Flow (Phone → Agent)
```
┌─────────────────┐
│ Incoming Call   │
│ (Twilio)        │
└────────┬────────┘
         │
         ▼
┌──────────────────────────────────┐
│ POST /api/twilio/inbound         │
│ Webhook Handler                  │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Create CallLog record            │
│ Lookup Agent by Agent ID         │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Generate TwiML Response          │
│ with <Gather> action             │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Twilio Records Caller's Speech   │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ POST /api/twilio/gather-response │
│ Webhook with audio              │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ 1. STT: Transcribe audio        │
│    (Deepgram)                   │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ 2. LLM: Generate response       │
│    (voicePipeline.processText)  │
│    System Prompt + Context +    │
│    Conversation History         │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ 3. TTS: Synthesize speech       │
│    (ttsService.synthesize)      │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ 4. Loop: Wait for next input    │
│    OR End call condition met    │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ POST /api/twilio/status         │
│ Call Completed/Failed           │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Generate summary & sentiment    │
│ Store call recording (S3)       │
│ Trigger webhooks                │
│ Create leads if applicable      │
└──────────────────────────────────┘
```

### Outbound Call Flow (Agent → Phone)
```
┌──────────────────────┐
│ Start Campaign       │
│ /api/campaigns/start │
└────────┬─────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ campaignWorker.processCampaigns()│
│ (runs every 10 seconds)          │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Get next pending phone from list │
│ Check concurrent call limit      │
│ (max 5 simultaneous)             │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ POST /api/twilio/outbound        │
│ initiateCall(agentId, phoneNum)  │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Twilio makes call                │
│ Callback to /api/twilio/         │
│ outbound-connect TwiML           │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Play firstMessage from agent     │
│ Generate <Gather> for recording  │
│ Optional: AMD (Answering Machine)│
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Same flow as inbound:            │
│ STT → LLM → TTS → Listen loop    │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ POST /api/twilio/status          │
│ Update campaign number status    │
│ Mark as completed/failed         │
└────────┬─────────────────────────┘
         │
         ▼
┌──────────────────────────────────┐
│ If more numbers pending:         │
│ DELAY_BETWEEN_CALLS (configurable)
│ Make next call                   │
└──────────────────────────────────┘
```

### Web Browser Call Flow (WebSocket)
```
┌──────────────────────────────┐
│ Browser → /voice WebSocket   │
│ Connect                      │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│ Send init message:           │
│ { type: 'init',              │
│   agentId: 'agent123' }      │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│ Load Agent + System Prompt   │
│ Create VoicePipeline         │
│ Send 'ready' message         │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│ Browser captures audio       │
│ Send chunks via:             │
│ { type: 'audio',             │
│   data: Uint8Array }         │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│ Server processes chunk:      │
│ 1. Accumulate until silence  │
│ 2. STT: Transcribe           │
│ 3. LLM: Generate response    │
│ 4. TTS: Synthesize           │
│ 5. Send audio chunks back    │
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│ Browser plays audio          │
│ Display transcript           │
│ Listen for next input        │
└──────────────────────────────┘
```

---

## Key Features

### 1. **AI Voice Agents**
- Custom system prompts for agent personality
- Support for multiple LLMs (Groq, OpenAI, Gemini)
- LLM model fallback mechanism
- Temperature control for response creativity
- Multi-language support (15+ languages)
- Custom first message greeting

### 2. **Phone Number Management**
- Purchase Twilio phone numbers
- Support for SMS and WhatsApp
- Phone number testing
- Country selection

### 3. **Inbound Call Routing**
- Automatic caller routing to agents
- Confidence-based speech recognition
- Conversation history tracking
- Graceful end-call detection
- Sentiment analysis in real-time

### 4. **Outbound Campaigns**
- Bulk calling to phone number lists
- Configurable concurrent calls (default 5)
- Delay between calls
- Call state tracking
- Campaign pause/resume
- Success/failure statistics

### 5. **Call Flow Workflows**
- Visual node-based workflow builder
- Node types: trigger, speak, gather, condition, action, end
- Variable substitution {{name}}, {{phoneNumber}}
- Conditional branching
- API call execution
- Webhook triggers

### 6. **Knowledge Base RAG**
- Upload PDF, text, or URL documents
- Automatic chunking and embedding
- Semantic search
- Context injection into LLM prompts
- Multi-language support

### 7. **Call Recording & Storage**
- AWS S3 integration
- Automatic upload on call completion
- Presigned URL generation
- Transcript storage as JSON
- Recording metadata tracking

### 8. **Analytics Dashboard**
- Call volume trends
- Sentiment analysis (positive/negative/neutral)
- Customer satisfaction metrics (CSAT, NPS, CES)
- QA scoring and grading
- Agent performance comparison
- Campaign conversion rates
- Cost tracking

### 9. **CRM Integration**
- Salesforce integration
- HubSpot integration
- Lead creation from calls
- Custom field mapping
- Automatic sync

### 10. **Webhook Integration**
- n8n integration
- Zapier integration
- Custom webhooks
- Event-based triggering:
  - call_started
  - call_completed
  - call_failed
  - lead_created
  - sentiment_detected
  - transfer_requested
- HMAC signature verification
- Retry with exponential backoff

### 11. **Human Handoff**
- Transfer to phone number
- Sentiment-based routing
- Keyword-triggered transfer
- Max failed attempts limit
- Voicemail message for AMD

### 12. **Real-time WebSocket**
- Live audio streaming
- Bidirectional communication
- Server-sent audio chunks
- Transcript updates
- Connection status

### 13. **Multi-Provider Support**
- **LLM Providers**: Groq, OpenAI, Google Gemini
- **STT Providers**: Deepgram
- **TTS Providers**: Edge TTS, ElevenLabs, Google, Azure
- **Phone**: Twilio (SMS, Voice, WhatsApp)
- **Storage**: AWS S3
- **Cache**: Redis
- **Database**: MongoDB

### 14. **Security Features**
- JWT token-based authentication
- BCrypt password hashing
- Rate limiting (global, auth, voice, campaign)
- CORS support
- Helmet security headers
- Request correlation IDs
- HMAC webhook verification
- Role-based access control (user, admin, super_admin)

### 15. **Scalability Features**
- Redis session management for distributed deployment
- Concurrent call limiting
- Graceful degradation on LLM failures
- Backpressure handling for audio streams
- Horizontal scalability (stateless services)

---

## Middleware & Security

### Request Processing Pipeline

```
1. Helmet              → Security headers
2. CORS               → Cross-origin resource sharing
3. Static Files       → Serve widget.js
4. JSON Parser        → Parse request body (10MB limit)
5. Correlation ID     → Unique request tracking
6. Morgan             → HTTP request logging
7. Rate Limiting      → Global rate limiter
8. Routes             → Handle specific endpoints
9. Error Handler      → Catch and format errors
```

### Rate Limiting Strategies

```javascript
globalLimiter:
  - 100 requests per 15 minutes
  - Applied to all /api/* routes

authLimiter:
  - 5 login attempts per 15 minutes
  - Brute-force protection

voiceCallLimiter:
  - 50 calls per minute per user
  - Prevent call spam

campaignLimiter:
  - 100 campaigns per hour per user
  - Campaign creation throttling
```

### Authentication Flow

```
1. User registers with email + password
   ↓
2. Password hashed with bcrypt (salt rounds: 12)
   ↓
3. User logs in with email + password
   ↓
4. Server generates JWT token
   - Payload: { id, email, role }
   - Secret: JWT_SECRET
   - Expiry: 24 hours (configurable)
   ↓
5. Client sends token in Authorization header
   ↓
6. Middleware verifies JWT
   ↓
7. On token expiry, client calls /refresh-token
   ↓
8. Server issues new token
```

### Error Handling

All routes wrapped with `asyncHandler` to catch errors:

```javascript
app.get('/api/agents', asyncHandler(async (req, res) => {
  // No try-catch needed
  const agents = await Agent.find({ userId: req.user._id });
  res.json(agents);
}));

// Error caught by middleware
errorHandler(err, req, res, next)
  → Formats response
  → Logs error with requestId
  → Returns 400/500 with message
```

---

## Configuration & Deployment

### Environment Variables (.env)

```bash
# Server
NODE_ENV=production
PORT=5000
JWT_SECRET=your-super-secret-jwt-key
MONGODB_URI=mongodb://localhost:27017/vaaniDB
REDIS_URL=redis://localhost:6379

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token

# LLM Providers
GROQ_API_KEY=gsk_xxxxx
OPENAI_API_KEY=sk-xxxxx
GEMINI_API_KEY=AIzaSyxxxxxxx
GROQ_FALLBACK_MODELS=llama-3.1-8b-instant,llama-3.3-70b-versatile

# Speech & Voice
DEEPGRAM_API_KEY=xxxxx
ELEVENLABS_API_KEY=xxxxx
ELEVENLABS_MODEL_ID=eleven_monolingual_v1

# AWS S3
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=xxxxx
AWS_SECRET_ACCESS_KEY=xxxxx
AWS_S3_BUCKET=vaaniai-recordings

# Campaign Settings
MAX_CONCURRENT_CALLS=5
DELAY_BETWEEN_CALLS=2000
CAMPAIGN_WORKER_INTERVAL=10000

# LLM Caching
LLM_RESPONSE_CACHE_ENABLED=true
LLM_RESPONSE_CACHE_MAX=50
LLM_RESPONSE_CACHE_TTL_MS=300000
ROLLING_SUMMARY_THRESHOLD=12
```

### Docker Deployment

```dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application
COPY . .

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start server
CMD ["node", "server.js"]
```

### Docker Compose

```yaml
version: '3.8'
services:
  vaaniai-backend:
    build: .
    ports:
      - "5000:5000"
    environment:
      NODE_ENV: production
      MONGODB_URI: mongodb://mongo:27017/vaaniDB
      REDIS_URL: redis://redis:6379
    depends_on:
      - mongo
      - redis

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  mongo-data:
```

### PM2 Ecosystem Config

```javascript
module.exports = {
  apps: [
    {
      name: 'vaaniai-backend',
      script: './server.js',
      instances: 4,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vaaniai-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vaaniai-backend
  template:
    metadata:
      labels:
        app: vaaniai-backend
    spec:
      containers:
      - name: vaaniai-backend
        image: your-registry/vaaniai-backend:latest
        ports:
        - containerPort: 5000
        env:
        - name: MONGODB_URI
          valueFrom:
            secretKeyRef:
              name: vaaniai-secrets
              key: mongodb-uri
        - name: REDIS_URL
          valueFrom:
            configMapKeyRef:
              name: vaaniai-config
              key: redis-url
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 5000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 5000
          initialDelaySeconds: 5
          periodSeconds: 5
```

### Startup Commands

```bash
# Development
npm install
npm run dev

# Production (single instance)
npm install --production
npm start

# Production (multiple instances with PM2)
pm2 start ecosystem.config.js

# Production (Docker)
docker build -t vaaniai-backend .
docker run -p 5000:5000 --env-file .env vaaniai-backend

# Production (Docker Compose)
docker-compose up -d

# Run tests/evaluation
npm run eval:regression
npm run load:smoke
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        USER                                  │
├─────────────────────────────────────────────────────────────┤
│  Creates Agent:  "Customer Service Bot"                     │
│  - System Prompt: "You are a helpful support agent..."      │
│  - Voice: ElevenLabs (Bella)                                │
│  - LLM: Groq (llama-3.1-8b)                                 │
│  - Language: English                                         │
└──────────────────────────┬──────────────────────────────────┘
                           │
              Stores in MongoDB (Agent model)
                           │
        ┌──────────────────┴──────────────────┐
        │                                     │
        ▼                                     ▼
   ┌─────────────────┐           ┌──────────────────────┐
   │ Inbound Call    │           │ Outbound Campaign    │
   │ (Twilio webhook)│           │ (campaignWorker.js)  │
   └────────┬────────┘           └──────────┬───────────┘
            │                               │
            ▼                               ▼
    ┌──────────────────────────────────────────────────┐
    │ Create CallLog record (MongoDB)                  │
    └──────────────┬───────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
   ┌────────────────┐   ┌──────────────────┐
   │ WebSocket      │   │ Twilio TwiML     │
   │ (voiceSession) │   │ (gather/record)  │
   └────────┬───────┘   └────────┬─────────┘
            │                    │
            ▼                    ▼
    ┌──────────────────────────────────────────────────┐
    │ Audio Input (PCM 16-bit 16kHz)                   │
    └──────────────┬───────────────────────────────────┘
                   │
                   ▼
    ┌──────────────────────────────────────────────────┐
    │ deepgramService.transcribe()                     │
    │ Speech-to-Text (Deepgram API)                    │
    └──────────────┬───────────────────────────────────┘
                   │
              Transcript: "What's your refund status?"
                   │
                   ▼
    ┌──────────────────────────────────────────────────┐
    │ voicePipeline.processText()                      │
    ├──────────────────────────────────────────────────┤
    │ 1. Build LLM Prompt:                             │
    │    - System Prompt (Agent config)                │
    │    - Conversation History (CallLog.transcript)   │
    │    - User Message                                │
    │    - Knowledge Base Context (RAG)                │
    │    - User Memory (UserMemory model)              │
    └──────────────┬───────────────────────────────────┘
                   │
                   ▼
    ┌──────────────────────────────────────────────────┐
    │ groqService.generateResponse()                   │
    │ (with fallback to Gemini)                        │
    ├──────────────────────────────────────────────────┤
    │ LLM Input (max ~8000 tokens)                     │
    │ LLM Output: "Your refund is processing..."       │
    │ Tool calls: search_knowledge_base(), etc.        │
    └──────────────┬───────────────────────────────────┘
                   │
      ┌────────────┴────────────┐
      │                         │
      ▼                         ▼
   Regular Response        Tool Calling Loop
   "Your refund is..."     - Execute tool
   → TTS                   - Add result to context
                          - Re-query LLM
                          - Loop until no more tools
                          → TTS
                   │
                   ▼
    ┌──────────────────────────────────────────────────┐
    │ ttsService.synthesize()                          │
    │ Text-to-Speech (ElevenLabs / Edge TTS)           │
    ├──────────────────────────────────────────────────┤
    │ TTS Input: "Your refund is processing..."        │
    │ TTS Output: Audio buffer (MP3 / WAV)             │
    └──────────────┬───────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
   ┌────────────────┐   ┌──────────────────┐
   │ WebSocket      │   │ Twilio TwiML     │
   │ Send audio     │   │ Play audio       │
   │ chunks         │   │ to caller        │
   └────────┬───────┘   └────────┬─────────┘
            │                    │
            ▼                    ▼
    ┌──────────────────────────────────────────────────┐
    │ Client/Caller hears response                     │
    │ Speaks next input                                │
    │ → Loop continues OR call ends                    │
    └──────────────┬───────────────────────────────────┘
                   │
                   ▼
    ┌──────────────────────────────────────────────────┐
    │ Call Completion (Twilio status webhook)          │
    ├──────────────────────────────────────────────────┤
    │ 1. Update CallLog (end time, duration)           │
    │ 2. Generate summary (LLM)                        │
    │ 3. Analyze sentiment (LLM / ML)                  │
    │ 4. Extract leads (if applicable)                 │
    │ 5. Create Lead records                           │
    │ 6. Upload recording to S3                        │
    │ 7. Dispatch webhooks (webhook_dispatcher.js)     │
    │ 8. Sync to CRM (if configured)                   │
    │ 9. Send post-call SMS/WhatsApp                   │
    │ 10. Update analytics (UsageTracker)              │
    └──────────────────────────────────────────────────┘
```

---

## Performance & Optimization

### Caching Strategy
- **LLM Response Cache**: Cache FAQ-type repeated queries (TTL: 5 min)
- **Redis Session Cache**: Store active WebSocket sessions
- **Knowledge Base Embeddings**: Cache document chunk embeddings
- **Rate Limiting**: Redis-backed distributed rate limiting

### Scalability Considerations
- **Stateless Services**: All services are stateless, can run on multiple servers
- **Redis Session Management**: Enables horizontal scaling
- **Concurrent Call Limiting**: Prevents server overload
- **Asynchronous Processing**: Webhooks, recording upload in background

### Monitoring & Logging
- **Request Correlation IDs**: Track requests across services
- **Winston Logging**: Structured logs with timestamps
- **Morgan HTTP Logging**: Request/response logging
- **Health Check Endpoint**: GET /health for orchestrators
- **Metrics Collection**: Call counts, latency, errors in CallLog/UsageTracker

---

## Deployment Checklist

- [ ] Set all required environment variables (.env)
- [ ] Initialize MongoDB with indexes
- [ ] Configure Redis cache
- [ ] Set up AWS S3 bucket and credentials
- [ ] Configure Twilio account and webhook URLs
- [ ] Add LLM API keys (Groq, OpenAI, Gemini)
- [ ] Add speech provider keys (Deepgram, ElevenLabs)
- [ ] Test voice pipeline with sample audio
- [ ] Set up SSL/TLS certificates
- [ ] Configure rate limiting thresholds
- [ ] Set up monitoring/alerting
- [ ] Test inbound/outbound call flows
- [ ] Verify WebSocket connectivity
- [ ] Test webhook delivery
- [ ] Load testing with multiple concurrent calls
- [ ] Set up backup strategy for MongoDB
- [ ] Configure log aggregation
- [ ] Plan scaling strategy

---

## Summary

**VaaniAI Backend** is a production-ready, enterprise-grade voice AI platform that:

✅ Handles thousands of concurrent voice calls
✅ Supports multiple AI models with fallback mechanisms
✅ Integrates with Twilio for SMS/Voice/WhatsApp
✅ Stores recordings in AWS S3
✅ Provides real-time analytics and sentiment analysis
✅ Enables visual workflow building
✅ Supports 15+ languages including Indian languages
✅ Scales horizontally with Redis + MongoDB
✅ Implements security best practices
✅ Provides webhook integration for third-party services

The architecture is modular, maintainable, and follows Node.js best practices with clear separation of concerns between routes, services, and data models.
