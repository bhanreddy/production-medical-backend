const jwt = require('jsonwebtoken');
require('dotenv').config({ path: '/Users/bhanureddy/Desktop/medical/Medical POS Backend/.env' });

const secret = process.env.SUPABASE_JWT_SECRET;
console.log('Secret starts with:', secret ? secret.substring(0, 5) : 'NULL');

// Just grabbing any token string from Supabase frontend config or we can just try to see if Secret matches expected format.
console.log('Valid Secret Format:', secret && secret.length > 20);
