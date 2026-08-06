/**
 * Plivo Service
 * Centralized Plivo client factory + helpers
 */

const plivo = require('plivo');

/**
 * Get Plivo client — user-level credentials first, then env fallback
 */
function getPlivoClient(user) {
  const authId    = user?.settings?.plivoAuthId    || process.env.PLIVO_AUTH_ID;
  const authToken = user?.settings?.plivoAuthToken || process.env.PLIVO_AUTH_TOKEN;
  if (!authId || !authToken) {
    throw new Error('Plivo credentials not configured. Please add PLIVO_AUTH_ID and PLIVO_AUTH_TOKEN.');
  }
  return new plivo.Client(authId, authToken);
}

/**
 * Search available phone numbers on Plivo
 * @param {object} user - User document (for per-user credentials)
 * @param {object} options - { countryIso, type, pattern, limit }
 */
async function searchNumbers(user, { countryIso = 'US', type = 'local', pattern = '', limit = 20 } = {}) {
  const client = getPlivoClient(user);
  const params = {
    country_iso: countryIso.toUpperCase(),
    type,
    limit: parseInt(limit),
  };
  if (pattern) params.pattern = pattern;

  const response = await client.numbers.search(countryIso.toUpperCase(), params);
  // Plivo SDK v4 returns an array directly (not { objects: [] })
  const numbers = Array.isArray(response) ? response : (response.objects || []);
  return numbers.map(n => ({
    number:            n.number || n.id,
    region:            n.region || '',
    city:              n.city   || '',
    type:              n.type   || n.subType || type,
    monthlyRentalRate: n.monthlyRentalRate || n.monthly_rental_rate || '0',
    setupRate:         n.setupRate || n.setup_rate || '0',
    voiceRate:         n.voiceRate || '0',
    countryIso:        n.country || countryIso,
    prerequisites:     n.prerequisites || [],
    restrictionText:   n.restrictionText || '',
    capabilities: {
      voice: n.voiceEnabled || n.voice === 'True' || n.voice === true,
      sms:   n.smsEnabled   || n.sms   === 'True' || n.sms   === true,
    },
  }));
}

/**
 * Buy a phone number and configure its webhook to our backend
 * @param {object} user - User document
 * @param {string} number - E.164 number to purchase
 * @param {string} backendUrl - Backend base URL for webhooks
 */
async function buyNumber(user, number, backendUrl) {
  const client = getPlivoClient(user);

  const appName   = `VaaniAI-${Date.now()}`;
  const answerUrl = `${backendUrl}/api/plivo/inbound`;
  const hangupUrl = `${backendUrl}/api/plivo/hangup`;

  let appId = null;

  try {
    // Plivo SDK v4 — applications.create(appName, paramsObject)
    const appResponse = await client.applications.create(appName, {
      answer_url:    answerUrl,
      answer_method: 'POST',
      hangup_url:    hangupUrl,
      hangup_method: 'POST',
    });
    appId = appResponse.app_id || appResponse.appId || null;
    console.log(`✅ Plivo app created: ${appName} (ID: ${appId})`);
  } catch (appErr) {
    // App creation may fail if account is in trial mode or SDK version differs.
    // We can still purchase the number; webhook is configured via PLIVO_PHONE_NUMBER env fallback.
    console.warn(`⚠️  Plivo app creation skipped (${appErr.message}). Number will be bought without app binding.`);
  }

  // Buy the number; pass appId if we successfully created it (otherwise undefined)
  if (appId) {
    await client.numbers.buy(number, appId);
  } else {
    await client.numbers.buy(number);
  }

  // If no app was created, point the number to our inbound URL via number update
  if (!appId) {
    try {
      await client.numbers.update(number, {
        answer_url:    answerUrl,
        answer_method: 'POST',
        hangup_url:    hangupUrl,
        hangup_method: 'POST',
      });
      console.log(`✅ Number ${number} webhook set directly (no app)`);
    } catch (updateErr) {
      console.warn(`⚠️  Could not set webhook on ${number}: ${updateErr.message}`);
    }
  }

  return {
    success: true,
    number,
    appId,
    appName,
  };
}

/**
 * Update a phone number's application (change webhook)
 */
async function updateNumberApp(user, number, appId) {
  const client = getPlivoClient(user);
  return client.numbers.update(number, { app_id: appId });
}

/**
 * Release (delete) a phone number
 */
async function releaseNumber(user, number) {
  const client = getPlivoClient(user);
  return client.numbers.unrent(number);
}

/**
 * Make an outbound call via Plivo
 * @param {object} opts - { user, from, to, answerUrl, statusUrl, machineDetection }
 */
async function makeCall({ user, from, to, answerUrl, statusUrl, machineDetection = false }) {
  const client = getPlivoClient(user);

  // Ensure E.164 format (+XXXXXXXXXXX). If number is missing '+', add it.
  const normalizeE164 = (num) => {
    if (!num) return num;
    const s = String(num).trim();
    return s.startsWith('+') ? s : '+' + s;
  };
  const fromE164 = normalizeE164(from);
  const toE164   = normalizeE164(to);

  const params = {
    answer_url:    answerUrl,
    answer_method: 'POST',
  };

  if (statusUrl) {
    params.hangup_url    = statusUrl;
    params.hangup_method = 'POST';
  }

  if (machineDetection) {
    params.machine_detection      = 'hangup';
    // Plivo requires machine_detection_time in MILLISECONDS (2000–10000).
    params.machine_detection_time = 4500;
  }

  console.log(`[plivoService] makeCall ${fromE164} → ${toE164}`);
  const response = await client.calls.create(fromE164, toE164, answerUrl, params);
  return response;
}

/**
 * Get live call status
 */
async function getCallStatus(user, callUuid) {
  const client = getPlivoClient(user);
  const call = await client.calls.get(callUuid);
  return call;
}

/**
 * Hang up an active call
 */
async function hangupCall(user, callUuid) {
  const client = getPlivoClient(user);
  return client.calls.hangup(callUuid);
}

/**
 * List all numbers on this Plivo account
 */
async function listAccountNumbers(user) {
  const client = getPlivoClient(user);
  const response = await client.numbers.list();
  return response.objects || [];
}

/**
 * Build Plivo XML-ML response (same structure as TwiML but with Plivo tags)
 */
function buildXmlResponse(text, options = {}) {
  const r = new plivo.Response();
  if (text) {
    r.addSpeak(text, {
      voice:    options.voice    || 'WOMAN',
      language: options.language || 'en-US',
    });
  }
  return r.toXML();
}

module.exports = {
  getPlivoClient,
  searchNumbers,
  buyNumber,
  updateNumberApp,
  releaseNumber,
  makeCall,
  getCallStatus,
  hangupCall,
  listAccountNumbers,
  buildXmlResponse,
};
