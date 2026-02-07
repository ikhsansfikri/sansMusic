const client = require('./client');
require('./commands');
require('./events');
const { TOKEN } = require('./config');

client.login(TOKEN);
