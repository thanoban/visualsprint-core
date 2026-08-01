// Central place for backend base URL so every fetch call agrees on one source of truth.
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
