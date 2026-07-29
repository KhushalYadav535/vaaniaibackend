const fs = require('fs');

const alacHelper = `
const alacQuery = (user, type = 'agentId') => {
  if (user.accountType === 'member' && user.restrictAgents) {
    return { [type]: { $in: user.assignedAgents || [] } };
  }
  return {};
};
`;

let content = fs.readFileSync('d:/vaaniai/vaaniaibackend/routes/analytics.js', 'utf8');

if (!content.includes('alacQuery')) {
  content = content.replace("router.use(protect);", "router.use(protect);\n" + alacHelper);
}

// Replace Agent queries
content = content.replace(/Agent\.countDocuments\(\{\s*userId/g, "Agent.countDocuments({ ...alacQuery(req.user, '_id'), userId");
content = content.replace(/Agent\.find\(\{\s*userId/g, "Agent.find({ ...alacQuery(req.user, '_id'), userId");

// Replace CallLog queries
content = content.replace(/CallLog\.countDocuments\(\{\s*userId/g, "CallLog.countDocuments({ ...alacQuery(req.user, 'agentId'), userId");
content = content.replace(/CallLog\.find\(\{\s*userId/g, "CallLog.find({ ...alacQuery(req.user, 'agentId'), userId");
content = content.replace(/CallLog\.aggregate\(\[\s*\{\s*\$match:\s*\{\s*userId/g, "CallLog.aggregate([\n      { $match: { ...alacQuery(req.user, 'agentId'), userId");

fs.writeFileSync('d:/vaaniai/vaaniaibackend/routes/analytics.js', content);
console.log('Fixed analytics with helper');
