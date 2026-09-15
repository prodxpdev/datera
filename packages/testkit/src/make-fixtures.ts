#!/usr/bin/env node
import { generateFixtures } from './fixtures.js';

const paths = await generateFixtures();
console.log(`Fixtures written to ${paths.root}`);
