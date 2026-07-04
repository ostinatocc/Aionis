import { z } from "zod";

export const EXECUTION_STRING_LIST_MAX_ITEMS = 64;
export const EXECUTION_STRING_LIST_ITEM_MAX_LENGTH = 2048;

export const ExecutionStringListSchema = z
  .array(z.string().trim().min(1).max(EXECUTION_STRING_LIST_ITEM_MAX_LENGTH))
  .max(EXECUTION_STRING_LIST_MAX_ITEMS)
  .default([]);
