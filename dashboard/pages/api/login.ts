import type { NextApiRequest, NextApiResponse } from "next";
import { setAuthCookie } from "../../lib/auth";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const token = process.env.ADMIN_TOKEN?.trim();
  const submitted = (req.body?.token ?? "").trim();

  if (!token || submitted !== token) {
    return res.status(401).json({ error: "Invalid token" });
  }

  setAuthCookie(res, token);
  return res.status(200).json({ ok: true });
}
