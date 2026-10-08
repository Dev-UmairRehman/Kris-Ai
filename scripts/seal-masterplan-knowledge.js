'use strict';

/* Seals masterplan/knowledge/* into masterplan/knowledge.enc with the key in
   MP_KNOWLEDGE_KEY (read from .env or the environment). See
   masterplan/knowledge.js for why. */

require('../lib/config'); // loads .env
const knowledge = require('../masterplan/knowledge');

const out = knowledge.seal();
console.log('sealed %d files into masterplan/knowledge.enc (%d KB)', out.files, Math.round(out.bytes / 1024));
