import { env } from "./config/env.js";

console.log("Environment variables loaded successfully!");

console.log("PORT:", env.PORT);

console.log(
    "DATABASE_URL:",
    env.DATABASE_URL ? "Configured" : "Missing"
);

console.log("Zod validation passed!");
