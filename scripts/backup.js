'use strict';
// Консистентна копія бази: npm run backup -- ./backups/shop.db  (фото копіюйте з DATA_DIR/uploads окремо)
const { db } = require('../db'); const path = require('node:path');
const out = path.resolve(process.argv[2] || `backup-${new Date().toISOString().slice(0, 10)}.db`);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); console.log('Копію збережено:', out);
