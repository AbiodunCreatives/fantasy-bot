import type { NextApiRequest, NextApiResponse } from "next";
import { isAuthenticated } from "../../lib/auth";
import { getDashboardData } from "../../lib/dashboard";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const data = await getDashboardData();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (err) {
    console.error("[dashboard api]", err);
    return res.status(500).json({ error: "Failed to load dashboard data" });
  }
}
