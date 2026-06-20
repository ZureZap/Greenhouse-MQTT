/**
 * dashboard.js
 * Quản lý trang Dashboard - hiển thị tổng quan các chỉ số môi trường nhà kính,
 * hỗ trợ chuyển đổi giữa các nhà kính.
 * Sử dụng API backend thay vì state.js.
 */

import { buildZoneTree, getGreenhouses, getGreenhouseIdByZoneId } from "./utils.js";
import { getDevices, getAlerts, getSensorData, getZones } from "./api.js";

// --- Biến toàn cục ---
let areaChart, radarChart, lineChart;
let currentGreenhouseId = null;
let greenhouses = [];
let devices = [];
let alerts = [];
let zones = [];
let sensorData = [];
let dashboardRefreshTimer = null;

function scheduleDashboardRefresh() {
  clearTimeout(dashboardRefreshTimer);
  dashboardRefreshTimer = setTimeout(() => {
    const dashboardPage = document.getElementById("page-dashboard");
    if (dashboardPage?.classList.contains("active")) {
      renderDashboardPage();
    }
  }, 10000);
}

// ===================== LẤY DỮ LIỆU =====================
async function loadDashboardData() {
  try {
    const [loadedDevices, loadedAlerts, flatZones] = await Promise.all([
      getDevices(),
      getAlerts(),
      getZones()
    ]);
    devices = loadedDevices;
    alerts = loadedAlerts;
    zones = buildZoneTree(flatZones);
    greenhouses = getGreenhouses(zones);
    // Đảm bảo currentGreenhouseId vẫn hợp lệ sau khi load
    if (greenhouses.length > 0) {
      const saved = localStorage.getItem("selectedGreenhouse");
      if (saved && greenhouses.some((g) => String(g.id) === String(saved))) {
        currentGreenhouseId = String(saved);
      } else if (
        !currentGreenhouseId ||
        !greenhouses.some((g) => String(g.id) === String(currentGreenhouseId))
      ) {
        currentGreenhouseId = String(greenhouses[0].id);
      }
      sensorData = await getSensorData(currentGreenhouseId);
    }
  } catch (err) {
    console.error("Lỗi load dashboard data:", err);
    throw err;
  }
}

// ===================== LẤY ZONE THEO GREENHOUSE =====================
function getZonesByGreenhouse(greenhouseId) {
  const result = [];
  function traverse(nodes) {
    for (const node of nodes) {
      if (node.type === "zone") {
        const ghId = getGreenhouseIdByZoneId(node.id, zones); // truyền zones vào
        if (String(ghId) === String(greenhouseId)) {
          result.push(node);
        }
      }
      if (node.children) traverse(node.children);
    }
  }
  traverse(zones);
  return result;
}

// ===================== TÍNH TOÁN DỮ LIỆU THỐNG KÊ =====================
function getStatsForGreenhouse(greenhouseId) {
  const ghId = String(greenhouseId);
  const zoneList = getZonesByGreenhouse(ghId);
  const zoneIds = zoneList.map((z) => String(z.id));

  // Thiết bị
  const devsInGh = devices.filter((d) => zoneIds.includes(String(d.zone_id)));
  const totalDevices = devsInGh.length;
  const activeDevices = devsInGh.filter((d) => d.status === "ONLINE").length;
  const offlineDevices = devsInGh.filter((d) => d.status === "OFFLINE").length;
  const needReplace = devsInGh.filter((d) => d.status === "NEEDS_REPLACEMENT").length;

  // Cảnh báo
  const alertsInGh = alerts.filter((a) => zoneIds.includes(String(a.zone_id)));
  const criticalAlerts = alertsInGh.filter(
    (a) => a.severity === "critical" && a.status !== "resolved"
  ).length;
  const warningAlerts = alertsInGh.filter(
    (a) => a.severity === "warning" && a.status !== "resolved"
  ).length;
  const infoAlerts = alertsInGh.filter(
    (a) => a.severity === "info" && a.status !== "resolved"
  ).length;

  // Zone đang trồng
  const zonesWithRecipe = zoneList.filter((z) => z.recipe_id);

  // Nhiệt độ / độ ẩm trung bình
  let avgTemp = null,
    avgHum = null;
  const temperatures = zoneList
    .filter((zone) => zone.temperature !== null && zone.temperature !== undefined)
    .map((zone) => Number(zone.temperature))
    .filter(Number.isFinite);
  const humidities = zoneList
    .filter((zone) => zone.humidity !== null && zone.humidity !== undefined)
    .map((zone) => Number(zone.humidity))
    .filter(Number.isFinite);
  if (temperatures.length > 0) {
    avgTemp = temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length;
  }
  if (humidities.length > 0) {
    avgHum = humidities.reduce((sum, value) => sum + value, 0) / humidities.length;
  }

  return {
    avgTemp,
    avgHum,
    totalDevices,
    activeDevices,
    offlineDevices,
    needReplace,
    criticalAlerts,
    warningAlerts,
    infoAlerts,
    zonesWithRecipe: zonesWithRecipe.length,
    totalZones: zoneList.length
  };
}

// ===================== DỮ LIỆU BIỂU ĐỒ =====================
function getChartData(greenhouseId) {
  const rows = sensorData.filter((row) => String(row.greenhouseId) === String(greenhouseId));
  const bucketSizeMs = 10000;
  const buckets = new Map();

  for (const row of rows) {
    const timestamp = new Date(row.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;
    if (row.value === null || row.value === undefined || row.value === "") continue;
    const bucketTime = Math.floor(timestamp / bucketSizeMs) * bucketSizeMs;
    if (!buckets.has(bucketTime)) buckets.set(bucketTime, new Map());
    const metrics = buckets.get(bucketTime);
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    if (!metrics.has(row.metricType)) metrics.set(row.metricType, []);
    metrics.get(row.metricType).push(value);
  }

  const timestamps = [...buckets.keys()].sort((a, b) => a - b);
  const labels = timestamps.map((ts) =>
    new Date(ts).toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
  );
  const series = (metric) =>
    timestamps.map((ts) => {
      const values = buckets.get(ts).get(metric);
      if (!values?.length) return null;
      return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
    });
  return {
    labels,
    tempData: series("Temperature"),
    humData: series("Humidity"),
    lightData: series("Light"),
    co2Data: series("CO2"),
    soilData: series("SoilHumidity"),
    phData: series("PH")
  };
}

// ===================== BIỂU ĐỒ =====================
function destroyCharts() {
  if (areaChart) {
    areaChart.destroy();
    areaChart = null;
  }
  if (radarChart) {
    radarChart.destroy();
    radarChart = null;
  }
  if (lineChart) {
    lineChart.destroy();
    lineChart = null;
  }
}

function initCharts(data, stats) {
  const labels = data.labels;
  const { tempData, humData, lightData, co2Data, soilData, phData } = data;

  // 1. Area chart
  const areaCtx = document.getElementById("areaChart")?.getContext("2d");
  if (areaCtx) {
    areaChart = new Chart(areaCtx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Nhiệt độ (°C)",
            data: tempData,
            borderColor: "#f59e0b",
            backgroundColor: "rgba(245,158,11,0.15)",
            fill: true,
            tension: 0.4,
            pointRadius: 0
          },
          {
            label: "Độ ẩm (%)",
            data: humData,
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59,130,246,0.15)",
            fill: true,
            tension: 0.4,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } }
      }
    });
  }

  // 2. Radar chart
  const radarCtx = document.getElementById("radarChart")?.getContext("2d");
  if (radarCtx) {
    const avgTemp = stats.avgTemp;
    const avgHum = stats.avgHum;
    const norm = (val, min, max) => {
      if (val === null || val === undefined || val === "") return null;
      const numericValue = Number(val);
      if (!Number.isFinite(numericValue)) return null;
      return Math.max(0, Math.min(100, ((numericValue - min) / (max - min)) * 100));
    };
    const tempScore = norm(avgTemp, 15, 35);
    const humScore = norm(avgHum, 40, 90);
    const latest = (metric) =>
      [...sensorData]
        .reverse()
        .find(
          (row) =>
            String(row.greenhouseId) === String(currentGreenhouseId) && row.metricType === metric
        )?.value;
    const lightScore = norm(latest("Light"), 0, 30000);
    const co2Score = norm(latest("CO2"), 300, 1200);
    const phScore = norm(latest("PH"), 4, 9);
    const soilScore = norm(latest("SoilHumidity"), 30, 90);

    radarChart = new Chart(radarCtx, {
      type: "radar",
      data: {
        labels: ["Nhiệt độ", "Độ ẩm không khí", "Ánh sáng", "CO2", "pH", "Độ ẩm đất"],
        datasets: [
          {
            label: "Thực tế",
            data: [tempScore, humScore, lightScore, co2Score, phScore, soilScore],
            borderColor: "#10b981",
            backgroundColor: "rgba(16,185,129,0.4)",
            pointBackgroundColor: "#10b981"
          },
          {
            label: "Tối ưu",
            data: [85, 80, 75, 80, 85, 80],
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59,130,246,0.2)",
            pointBackgroundColor: "#3b82f6"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } }
      }
    });
  }

  // 3. Line chart
  const lineCtx = document.getElementById("lineChart")?.getContext("2d");
  if (lineCtx) {
    lineChart = new Chart(lineCtx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Ánh sáng (lux)",
            data: lightData,
            borderColor: "#f59e0b",
            tension: 0.4,
            pointRadius: 0,
            yAxisID: "y"
          },
          {
            label: "CO2 (ppm)",
            data: co2Data,
            borderColor: "#10b981",
            tension: 0.4,
            pointRadius: 0,
            yAxisID: "y1"
          },
          {
            label: "Độ ẩm đất (%)",
            data: soilData,
            borderColor: "#3b82f6",
            tension: 0.4,
            pointRadius: 0,
            yAxisID: "y2"
          },
          {
            label: "pH",
            data: phData,
            borderColor: "#8b5cf6",
            tension: 0.4,
            pointRadius: 0,
            yAxisID: "y3"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: {
            position: "left",
            title: { display: true, text: "Ánh sáng (lux)" }
          },
          y1: {
            position: "right",
            title: { display: true, text: "CO2 (ppm)" },
            grid: { drawOnChartArea: false }
          },
          y2: {
            position: "left",
            min: 0,
            max: 100,
            display: false
          },
          y3: {
            position: "right",
            min: 0,
            max: 14,
            display: false
          }
        }
      }
    });
  }
}

// ===================== RENDER =====================
export async function renderDashboardPage() {
  clearTimeout(dashboardRefreshTimer);
  const container = document.getElementById("page-dashboard");
  if (!container) return;

  try {
    await loadDashboardData();
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:20px; text-align:center; color:#ef4444;">Lỗi tải dữ liệu: ${err.message}</div>`;
    return;
  }

  if (greenhouses.length === 0) {
    container.innerHTML =
      '<div class="card" style="padding:20px; text-align:center;">Không có dữ liệu nhà kính</div>';
    return;
  }

  // Đảm bảo currentGreenhouseId hợp lệ
  if (
    !currentGreenhouseId ||
    !greenhouses.some((g) => String(g.id) === String(currentGreenhouseId))
  ) {
    currentGreenhouseId = String(greenhouses[0].id);
  }

  const stats = getStatsForGreenhouse(currentGreenhouseId);
  const chartData = getChartData(currentGreenhouseId);
  const formatMetric = (value, suffix) =>
    Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : "--";
  const metricStatus = (value, low, high) => {
    if (!Number.isFinite(value)) return "Chưa có dữ liệu";
    if (value > high) return "Cao";
    if (value < low) return "Thấp";
    return "Bình thường";
  };

  // Xây dựng giao diện
  container.innerHTML = `
        <div class="page-header" style="position: relative;">
            <div>
                <div class="page-title">Dashboard Tổng quan</div>
                <div class="page-sub">Giám sát thời gian thực các chỉ số môi trường nhà kính</div>
                <div class="page-sub">Tự động cập nhật mỗi 10 giây</div>
            </div>
            <div style="position: absolute; top: 0; right: 0;">
                <label style="font-size:0.85rem; color:#6b7280; margin-right:8px;">🏠 Nhà kính:</label>
                <select id="greenhouse-select" class="form-select" style="width:auto; display:inline-block;" aria-label="Chọn nhà kính">
                    ${greenhouses.map((gh) => `<option value="${gh.id}" ${String(gh.id) === String(currentGreenhouseId) ? "selected" : ""}>${gh.name}</option>`).join("")}
                </select>
            </div>
        </div>

        <!-- Hàng card thống kê chính -->
        <div class="grid grid-4" style="margin-bottom:20px">
            <div class="card">
                <div class="stat-icon" style="background:#fef3c7;color:#f59e0b">🌡️</div>
                <div class="stat-label">Nhiệt độ TB</div>
                <div class="stat-value">${formatMetric(stats.avgTemp, "°C")}</div>
                <span class="chip chip-default" style="margin-top:6px">${metricStatus(stats.avgTemp, 18, 28)}</span>
            </div>
            <div class="card">
                <div class="stat-icon" style="background:#dbeafe;color:#3b82f6">💧</div>
                <div class="stat-label">Độ ẩm TB</div>
                <div class="stat-value">${formatMetric(stats.avgHum, "%")}</div>
                <span class="chip chip-default" style="margin-top:6px">${metricStatus(stats.avgHum, 60, 80)}</span>
            </div>
            <div class="card">
                <div class="stat-icon" style="background:#dbeafe;color:#3b82f6">🔌</div>
                <div class="stat-label">Thiết bị</div>
                <div class="stat-value">${stats.totalDevices}</div>
                <span class="chip chip-default" style="margin-top:6px">Online: ${stats.activeDevices} / Offline: ${stats.offlineDevices}</span>
            </div>
            <div class="card">
                <div class="stat-icon" style="background:#fef3c7;color:#f59e0b">🚨</div>
                <div class="stat-label">Cảnh báo đang hoạt động</div>
                <div class="stat-value">${stats.criticalAlerts + stats.warningAlerts + stats.infoAlerts}</div>
                <span class="chip chip-default" style="margin-top:6px">Critical ${stats.criticalAlerts}</span>
            </div>
        </div>

        <!-- Hàng thống kê bổ sung -->
        <div class="grid grid-3" style="margin-bottom:20px">
            <div class="card">
                <div style="font-size:0.85rem; color:#6b7280;">Vùng trồng đang hoạt động</div>
                <div style="font-size:1.8rem; font-weight:600; color:#10b981;">${stats.zonesWithRecipe} / ${stats.totalZones}</div>
            </div>
            <div class="card">
                <div style="font-size:0.85rem; color:#6b7280;">Thiết bị cần thay thế</div>
                <div style="font-size:1.8rem; font-weight:600; color:#ef4444;">${stats.needReplace}</div>
            </div>
            <div class="card">
                <div style="font-size:0.85rem; color:#6b7280;">Cảnh báo (Warning / Info)</div>
                <div style="font-size:1.8rem; font-weight:600; color:#f59e0b;">${stats.warningAlerts + stats.infoAlerts}</div>
            </div>
        </div>

        <!-- Biểu đồ -->
        <div class="grid grid-8-4" style="margin-bottom:20px">
            <div class="card">
                <div class="card-title">Dữ liệu cảm biến gần đây</div>
                <div class="chart-container" style="height:300px"><canvas id="areaChart"></canvas></div>
            </div>
            <div class="card">
                <div class="card-title">Cân bằng môi trường</div>
                <div class="chart-container" style="height:300px"><canvas id="radarChart"></canvas></div>
            </div>
        </div>
        <div class="card">
            <div class="card-title">Xu hướng ánh sáng & CO2</div>
            <div class="chart-container" style="height:250px"><canvas id="lineChart"></canvas></div>
        </div>
    `;

  destroyCharts();
  initCharts(chartData, stats);

  // Sự kiện đổi greenhouse. Phần tử select vừa được tạo lại cùng container,
  // nên không có listener cũ cần loại bỏ.
  const select = document.getElementById("greenhouse-select");
  select.addEventListener("change", (e) => {
    const newId = e.target.value;
    currentGreenhouseId = String(newId);
    localStorage.setItem("selectedGreenhouse", newId);
    renderDashboardPage();
  });
  scheduleDashboardRefresh();
}

// Export các hàm cần thiết
export { getGreenhouses };
