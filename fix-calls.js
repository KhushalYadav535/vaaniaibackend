const fs = require('fs');
const file = 'd:/vaaniai/vaaniaibackend/routes/calls.js';
let content = fs.readFileSync(file, 'utf8');

const alacHelper = `
const alacQuery = (user, type = 'agentId') => {
  if (user.accountType === 'member' && user.restrictAgents) {
    return { [type]: { $in: user.assignedAgents || [] } };
  }
  return {};
};
`;

if (!content.includes('alacQuery')) {
  content = content.replace("router.use(protect);", "router.use(protect);\n" + alacHelper);
}

// Replace all req.user._id with req.effectiveUserId
content = content.replace(/req\.user\._id/g, "req.effectiveUserId");

// In Calls.js, we have queries like:
// { userId: req.effectiveUserId }
// or { _id: req.params.id, userId: req.effectiveUserId }
// We can just replace `{ userId: req.effectiveUserId` with `{ ...alacQuery(req.user), userId: req.effectiveUserId`
content = content.replace(/\{\s*userId:\s*req\.effectiveUserId/g, "{ ...alacQuery(req.user), userId: req.effectiveUserId");

fs.writeFileSync(file, content);
console.log('Fixed calls.js');
