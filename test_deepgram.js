const https = require('https');

const API_KEY = '5210152b43cbcdec11b8325321fff95c007b08c9';
const options = {
  hostname: 'api.deepgram.com',
  port: 443,
  path: '/v1/projects',
  method: 'GET',
  headers: {
    'Authorization': `Token ${API_KEY}`
  }
};

const req = https.request(options, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('Response:', data);
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.end();
