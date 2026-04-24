const mongoose = require('mongoose');

const LOCAL_URI = 'mongodb://localhost:27017/vaaniai';
const REMOTE_URI = 'mongodb://admin:vJUm4yLOD8eUZsBqtdGJYU47JsJFe8rO@213.210.37.237:32768/vaaniai?authSource=admin';

async function migrate() {
  console.log('Connecting to local DB...');
  const localConn = await mongoose.createConnection(LOCAL_URI).asPromise();
  
  console.log('Connecting to remote DB...');
  const remoteConn = await mongoose.createConnection(REMOTE_URI).asPromise();

  const collections = await localConn.db.listCollections().toArray();
  
  for (let collInfo of collections) {
    const collName = collInfo.name;
    console.log(`Migrating collection: ${collName}...`);
    
    const localCollection = localConn.db.collection(collName);
    const remoteCollection = remoteConn.db.collection(collName);

    const docs = await localCollection.find({}).toArray();
    
    if (docs.length > 0) {
      // Clear remote collection first
      await remoteCollection.deleteMany({});
      
      // Insert docs
      await remoteCollection.insertMany(docs);
      console.log(`Copied ${docs.length} documents for ${collName}`);
    } else {
      console.log(`No documents found in ${collName}, skipping.`);
    }
  }

  console.log('Migration completed successfully!');
  await localConn.close();
  await remoteConn.close();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
