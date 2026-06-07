const axios = require('axios');
async function test() {
  try {
    const res = await axios.get('http://localhost:5001/api/reports/dashboard');
    console.log(JSON.stringify(res.data, null, 2).substring(0, 800));
  } catch (err) {
    console.error('Error:', err.message);
  }
}
test();
