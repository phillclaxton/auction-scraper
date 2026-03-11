const express = require('express');
const path = require('path');
const db = require('./src/db');
const routes = require('./src/routes');
const config = require('./src/config');

db.init();

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(routes);

app.listen(config.PORT, () => {
  console.log(`CC Scraper running at http://localhost:${config.PORT}`);
});
