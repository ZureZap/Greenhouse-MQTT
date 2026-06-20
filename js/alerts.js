/**
 * alerts.js
 * Quản lý hệ thống cảnh báo nhà kính
 * Sử dụng API backend thay vì state.js.
 */

import { showToast } from "./app.js";
import { getCurrentUser } from "./auth.js";
import { escapeHtml } from "./utils.js";
import { getAlerts, updateAlertStatus, deleteAlert, getZones } from "./api.js";
import {
  buildZoneTree,
  getGreenhouses,
  getZoneName,
  timeSince
} from "./utils.js";

// ===================== BIẾN TOÀN CỤC =====================
let filterGreenhouseId = null;
let filterSeverity = null;
let alerts = [];
let zones = [];
let greenhouses = [];

// ===================== LOAD DỮ LIỆU =====================
async function loadAlertsData() {
  try {
    const [loadedAlerts, flatZones] = await Promise.all([getAlerts(), getZones()]);
    alerts = loadedAlerts;
    zones = buildZoneTree(flatZones);
    greenhouses = getGreenhouses(zones);
    return { alerts, zones, greenhouses };
  } catch (err) {
    showToast("Lỗi tải dữ liệu cảnh báo: " + err.message, "error");
    throw err;
  }
}

// ===================== RENDER =====================
export async function renderAlerts() {
  let filteredAlerts = alerts.filter((a) => a.status !== "resolved");

  // Lọc theo greenhouse
  if (filterGreenhouseId) {
    filteredAlerts = filteredAlerts.filter(
      (alert) => String(alert.greenhouse_id) === String(filterGreenhouseId)
    );
  }

  if (filterSeverity) {
    filteredAlerts = filteredAlerts.filter((alert) => alert.severity === filterSeverity);
  }

  // --- Cập nhật thống kê ---
  const active = filteredAlerts.filter((a) => a.status === "active");
  const acked = filteredAlerts.filter((a) => a.status === "acknowledged");
  const critical = filteredAlerts.filter((a) => a.severity === "critical");

  const activeCountEl = document.getElementById("al-active-count");
  if (activeCountEl) activeCountEl.textContent = active.length;

  const ackedCountEl = document.getElementById("al-acked-count");
  if (ackedCountEl) ackedCountEl.textContent = acked.length;

  const criticalEl = document.getElementById("al-critical-count");
  if (criticalEl) {
    criticalEl.textContent = critical.length;
    criticalEl.style.color = critical.length > 0 ? "#ef4444" : "#10b981";
  }

  // --- Ánh xạ mức độ ---
  const severityMap = {
    critical: ["chip-error", "🔴 Nghiêm trọng"],
    warning: ["chip-warning", "⚠ Cảnh báo"],
    info: ["chip-info", "ℹ Thông tin"]
  };
  const cardClassMap = {
    critical: "alert-critical",
    warning: "alert-warning-card",
    info: "alert-info-card"
  };

  // --- Danh sách cảnh báo ---
  const alertList = document.getElementById("alert-list");
  if (alertList) {
    if (filteredAlerts.length === 0) {
      alertList.innerHTML = `<div style="padding:20px; text-align:center; color:#6b7280;">
                ${filterGreenhouseId || filterSeverity ? "Không có cảnh báo phù hợp với bộ lọc." : "Không có cảnh báo nào đang hoạt động."}
            </div>`;
    } else {
      alertList.innerHTML = filteredAlerts
        .map((a) => {
          const zoneName = getZoneName(a.zone_id, zones) || "Không xác định";
          return `
                    <div class="alert-card ${cardClassMap[a.severity]}${a.status === "acknowledged" ? " alert-acked" : ""}">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
                            <div style="display:flex;gap:12px;flex:1">
                                <div style="font-size:24px;flex-shrink:0">
                                    ${a.severity === "critical" ? "🔴" : a.severity === "warning" ? "⚠️" : "ℹ️"}
                                </div>
                                <div style="flex:1">
                                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
                                        <span style="font-weight:600">${escapeHtml(a.title)}</span>
                                        <span class="chip ${severityMap[a.severity][0]}">${severityMap[a.severity][1]}</span>
                                        ${a.status === "acknowledged" ? '<span class="chip chip-success">✔ Đã xác nhận</span>' : ""}
                                    </div>
                                    <div style="font-size:0.85rem;color:#6b7280;margin-bottom:6px">${escapeHtml(a.description)}</div>
                                    <div style="display:flex;gap:12px;font-size:0.78rem;color:#9ca3af;flex-wrap:wrap">
                                        <span>📍 ${escapeHtml(zoneName)}</span>
                                        <span>🕐 ${timeSince(new Date(a.timestamp))}</span>
                                        ${a.acknowledgedBy ? `<span>✓ ${escapeHtml(a.acknowledgedBy)}</span>` : ""}
                                    </div>
                                </div>
                            </div>
                            <button class="btn-icon" onclick="window.dismissAlert('${a.id}')">✖</button>
                        </div>
                        <div style="display:flex;gap:8px">
                            ${
                              a.status === "active"
                                ? `<button class="btn btn-outline btn-sm" onclick="window.acknowledgeAlert('${a.id}')">Xác nhận đã xem</button>`
                                : ""
                            }
                            <button class="btn btn-success btn-sm" onclick="window.resolveAlert('${a.id}')">✔ Đánh dấu đã giải quyết</button>
                        </div>
                    </div>
                `;
        })
        .join("");
    }
  }

  // --- Timeline (mô phỏng) ---
  const escalationSteps = [
    {
      time: "Phút 0",
      action: "Thông báo trên Web/App cho Người vận hành",
      status: "completed"
    },
    { time: "Phút 15", action: "Gửi SMS cho Kỹ sư trưởng", status: "active" },
    {
      time: "Phút 30",
      action: "Gọi điện tự động cho Quản lý nhà kính",
      status: "pending"
    }
  ];
  const timeline = document.getElementById("escalation-timeline");
  if (timeline) {
    timeline.innerHTML = escalationSteps
      .map(
        (step) => `
            <li class="timeline-item">
                <div class="timeline-dot ${step.status === "completed" ? "dot-success" : step.status === "active" ? "dot-warning" : "dot-default"}">
                    ${step.status === "completed" ? "✔" : step.status === "active" ? "●" : "○"}
                </div>
                <div>
                    <div style="font-weight:600;font-size:0.875rem">${step.time}</div>
                    <div style="font-size:0.82rem;color:#6b7280;margin-top:2px">${step.action}</div>
                </div>
            </li>
        `
      )
      .join("");
  }
}

// ===================== RENDER TRANG =====================
export async function renderAlertsPage() {
  const container = document.getElementById("page-alerts");
  if (!container) return;

  try {
    await loadAlertsData();
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:20px; text-align:center; color:#ef4444;">Lỗi tải dữ liệu: ${err.message}</div>`;
    return;
  }

  container.innerHTML = `
        <div class="page-header" style="position: relative;">
            <div>
                <div class="page-title">Hệ thống Cảnh báo</div>
                <div class="page-sub">Quản lý cảnh báo với cơ chế leo thang tự động</div>
            </div>
            <div style="position:absolute;top:0;right:0;display:flex;gap:10px;align-items:end;flex-wrap:wrap;justify-content:flex-end">
              <div>
                <label class="form-label" for="greenhouse-filter" style="font-size:0.8rem">🏠 Nhà kính</label>
                <select id="greenhouse-filter" class="form-select" style="width:auto">
                    <option value="">-- Tất cả --</option>
                    ${greenhouses.map((gh) => `<option value="${gh.id}" ${String(gh.id) === String(filterGreenhouseId) ? "selected" : ""}>${escapeHtml(gh.name)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label class="form-label" for="severity-filter" style="font-size:0.8rem">⚠️ Cấp độ</label>
                <select id="severity-filter" class="form-select" style="width:auto">
                  <option value="">-- Tất cả --</option>
                  <option value="info" ${filterSeverity === "info" ? "selected" : ""}>Thông tin</option>
                  <option value="warning" ${filterSeverity === "warning" ? "selected" : ""}>Cảnh báo</option>
                  <option value="critical" ${filterSeverity === "critical" ? "selected" : ""}>Nghiêm trọng</option>
                </select>
              </div>
            </div>
        </div>
        <div class="grid grid-3" style="margin-bottom:20px">
            <div class="card">
                <div style="font-size:2.5rem;font-weight:700;color:#ef4444" id="al-active-count">0</div>
                <div style="font-size:0.85rem;color:#6b7280">Cảnh báo đang hoạt động</div>
            </div>
            <div class="card">
                <div style="font-size:2.5rem;font-weight:700;color:#f59e0b" id="al-acked-count">0</div>
                <div style="font-size:0.85rem;color:#6b7280">Đã xác nhận</div>
            </div>
            <div class="card">
                <div style="font-size:2.5rem;font-weight:700" id="al-critical-count">0</div>
                <div style="font-size:0.85rem;color:#6b7280">Mức độ nghiêm trọng</div>
            </div>
        </div>
        <div class="grid grid-8-4-full">
            <div class="card">
                <div class="card-title">Danh sách cảnh báo</div>
                <div id="alert-list"></div>
            </div>
            <div class="card">
                <div class="card-title">Cơ chế Leo thang Cảnh báo</div>
                <ul class="timeline" id="escalation-timeline"></ul>
                <div style="background:#dbeafe;border-radius:8px;padding:12px;margin-top:12px;font-size:0.8rem">
                    <div style="font-weight:600;margin-bottom:6px">Bộ lọc Debouncing & Throttling:</div>
                    <div>• Lỗi > 5 phút mới xử lý</div>
                    <div>• Tối đa 3 tin nhắn/giờ/mã lỗi</div>
                </div>
            </div>
        </div>
    `;

  // Sự kiện lọc greenhouse
  const filterSelect = document.getElementById("greenhouse-filter");
  filterSelect.addEventListener("change", (e) => {
    filterGreenhouseId = e.target.value || null;
    renderAlerts();
  });
  document.getElementById("severity-filter").addEventListener("change", (event) => {
    filterSeverity = event.target.value || null;
    renderAlerts();
  });

  await renderAlerts();
}

// ===================== XỬ LÝ SỰ KIỆN (GỌI API) =====================
export async function acknowledgeAlert(id) {
  try {
    const username = getCurrentUser()?.username || "Người dùng";
    await updateAlertStatus(id, "ACKNOWLEDGED");
    // Cập nhật cục bộ
    const alert = alerts.find((a) => String(a.id) === String(id));
    if (alert) {
      alert.status = "acknowledged";
      alert.acknowledgedBy = username;
    }
    await renderAlerts();
    showToast("Đã xác nhận cảnh báo");
  } catch (err) {
    showToast("Lỗi xác nhận cảnh báo: " + err.message, "error");
  }
}

export async function resolveAlert(id) {
  try {
    await updateAlertStatus(id, "RESOLVED");
    const alert = alerts.find((a) => String(a.id) === String(id));
    if (alert) alert.status = "resolved";
    await renderAlerts();
    showToast("Đã giải quyết cảnh báo");
  } catch (err) {
    showToast("Lỗi giải quyết cảnh báo: " + err.message, "error");
  }
}

export async function dismissAlert(id) {
  try {
    await deleteAlert(id);
    alerts = alerts.filter((a) => String(a.id) !== String(id));
    await renderAlerts();
    showToast("Đã loại bỏ cảnh báo", "info");
  } catch (err) {
    showToast("Lỗi xóa cảnh báo: " + err.message, "error");
  }
}

// ===================== EXPOSE GLOBAL =====================
window.acknowledgeAlert = acknowledgeAlert;
window.resolveAlert = resolveAlert;
window.dismissAlert = dismissAlert;
