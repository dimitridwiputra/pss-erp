import { z } from 'zod';

// Wire values stay as strings so arithmetic never receives a JSON float.
export const DecimalStringSchema = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
export const MoneyAmountSchema = DecimalStringSchema;
export const BusinessDateSchema = z.iso.date();
export const UtcTimestampSchema = z.iso.datetime();

export type DecimalString = z.infer<typeof DecimalStringSchema>;
export type BusinessDate = z.infer<typeof BusinessDateSchema>;

