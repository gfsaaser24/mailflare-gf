import { z } from "zod";
import { registerSchema } from "@/lib/validators";

/**
 * The password rule is taken from `registerSchema` rather than restated, so a
 * reset can never accept a password that signup would reject (or vice versa).
 */
export const resetPasswordSchema = z.object({
	token: z.string().min(1).max(256),
	password: registerSchema.shape.password,
});
