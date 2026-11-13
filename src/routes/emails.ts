import { Router } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma";

export const emailRouter = Router();

const scheduleSchema = z.object({
  recipient: z.email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
  sendAt: z.coerce.date(),
});

// POST /api/emails/schedule
emailRouter.post("/schedule", async (req, res) => {
  const data = scheduleSchema.parse(req.body);
  const job = await prisma.emailJob.create({ data });
  res.status(201).json(job);
});

// GET /api/emails/:id
emailRouter.get("/:id", async (req, res) => {
  const job = await prisma.emailJob.findUnique({
    where: { id: req.params.id },
  });

  if (!job) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json(job);
});
