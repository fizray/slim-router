import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getSettings, updateSettings, MUTABLE_SETTING_KEYS } from "@/lib/db/repos/settingsRepo.js";
import { buildAuthSetCookieHeader } from "@/lib/auth/dashboardSession.js";
import { resetComboRotation } from "open-sse/services/combo.js";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const settings = await getSettings();
    const { password, ...safeSettings } = settings;
    return NextResponse.json({ ...safeSettings, hasPassword: !!password }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400, headers: NO_STORE });
    }

    const updates = {};
    for (const key of MUTABLE_SETTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updates[key] = body[key];
      }
    }

    for (const budgetKey of ["globalDailyBudgetUsd", "globalMonthlyBudgetUsd"]) {
      if (Object.prototype.hasOwnProperty.call(updates, budgetKey)) {
        const val = updates[budgetKey];
        if (val === null || val === "") {
          updates[budgetKey] = null;
        } else {
          const n = Number(val);
          if (!Number.isFinite(n) || n <= 0) {
            return NextResponse.json({ error: `${budgetKey} must be a positive number or null` }, { status: 400, headers: NO_STORE });
          }
          updates[budgetKey] = n;
        }
      }
    }

    let passwordRotated = false;
    if (body.newPassword !== undefined) {
      const newPassword = String(body.newPassword || "");
      if (newPassword.length < 12) {
        return NextResponse.json({ error: "New password must be at least 12 characters" }, { status: 400, headers: NO_STORE });
      }
      if (newPassword === "123456") {
        return NextResponse.json({ error: "Default password is forbidden" }, { status: 400, headers: NO_STORE });
      }

      const currentSettings = await getSettings();
      const currentHash = currentSettings.password;
      if (!currentHash) {
        return NextResponse.json({ error: "Admin password not initialized" }, { status: 500, headers: NO_STORE });
      }
      if (!body.currentPassword || !(await bcrypt.compare(String(body.currentPassword), currentHash))) {
        return NextResponse.json({ error: "Invalid current password" }, { status: 401, headers: NO_STORE });
      }

      updates.password = await bcrypt.hash(newPassword, 12);
      updates.sessionVersion = (currentSettings.sessionVersion || 1) + 1;
      passwordRotated = true;
    }

    const settings = await updateSettings(updates);

    if (
      Object.prototype.hasOwnProperty.call(updates, "comboStrategy") ||
      Object.prototype.hasOwnProperty.call(updates, "comboStickyRoundRobinLimit") ||
      Object.prototype.hasOwnProperty.call(updates, "comboStrategies")
    ) {
      resetComboRotation();
    }

    const headers = { ...NO_STORE };
    if (passwordRotated) {
      headers["Set-Cookie"] = await buildAuthSetCookieHeader(request);
    }

    const { password, ...safeSettings } = settings;
    return NextResponse.json({ ...safeSettings, hasPassword: !!password, passwordRotated }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500, headers: NO_STORE });
  }
}
