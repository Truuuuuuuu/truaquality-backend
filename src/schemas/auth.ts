import { z } from "zod";

export const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, "password is required"),
});
