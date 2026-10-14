import type { Response } from "express";

export function enviarErro(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ error: { code, message, ...extra } });
}

export function envelopeLista<T>(items: T[], page: number, limit: number, total: number, extra: Record<string, unknown> = {}) {
  return { items, page, limit, total, ...extra };
}
