import "dotenv/config";
import { z } from "zod";
const schema = z.object({
    PORT : z.coerce.number().default(4000),
    DATABASE_URL : z.string().min(1),
});

export const env = schema.parse(process.env);
