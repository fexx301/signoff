import { config } from "./config.js";
import { JobStore } from "./db.js";

export const store = new JobStore(config.dbPath);
