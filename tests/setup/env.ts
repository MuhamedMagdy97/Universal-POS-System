import { config } from "dotenv";

config({ quiet: true });

// Integration tests must never touch the development database.
const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl) {
  process.env.DATABASE_URL = testUrl;
}
