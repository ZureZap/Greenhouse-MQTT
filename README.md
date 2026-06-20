# Greenhouse Flower Management

Ứng dụng quản lý nhà kính trồng hoa theo mô hình ba lớp:

- Frontend: HTML, CSS và JavaScript thuần.
- Backend: Node.js, Express, REST API và MQTT client.
- Database: Microsoft SQL Server.
- Sensor: chương trình mô phỏng publish dữ liệu qua Eclipse Mosquitto.

## Chức năng

- Dashboard hiển thị đủ 6 chỉ số: nhiệt độ, độ ẩm không khí, ánh sáng, độ ẩm đất, pH và CO2.
- Quản lý cấu trúc `Farm → Greenhouse → Zone` và gán công thức cho Zone.
- Quản lý SENSOR, OUTPUT_DEVICE, Gateway và trạng thái thiết bị.
- Tạo Recipe, GrowthStage và 6 Threshold Min/Max cho từng giai đoạn.
- Theo dõi tiến độ tại Zone; xem tiến độ, ngưỡng, dữ liệu và cảnh báo chi tiết tại Growth.
- Điều khiển thiết bị AUTO/MANUAL và tự trả về AUTO khi hết thời gian thủ công.
- Nhận dữ liệu MQTT, ghi SensorData, tạo/giải quyết AlertLog và điều khiển AUTO.
- Audit Log cho thao tác người dùng và hành động hệ thống.
- Đăng nhập, quên/đổi mật khẩu, quản lý tài khoản và phân quyền.

## Phân quyền

| Vai trò | Chức năng |
|---|---|
| OWNER | Toàn bộ hệ thống |
| TECHNICIAN | Dashboard, Device, Growth, Control ở chế độ AUTO |
| OPERATOR | Dashboard và Control |

Frontend ẩn menu không có quyền; backend tiếp tục kiểm tra token và vai trò tại API.

## Cấu trúc

```text
Greenhouse-Flower-Management/
├── index.html
├── css/
├── js/
├── smartfarm-api/
│   ├── server.js
│   ├── simulation.js
│   ├── mqtt-service.js
│   ├── mqtt-sensor-simulator.js
│   └── .env.example
├── SQLQuery1.sql
└── README.md
```

## Yêu cầu trên Windows

- Node.js 18 trở lên.
- Microsoft SQL Server và SQL Server Management Studio.
- Eclipse Mosquitto chạy tại `127.0.0.1:1883`.
- VS Code Live Server hoặc một HTTP server tĩnh.

Kiểm tra Mosquitto:

```powershell
Get-Service mosquitto
Test-NetConnection 127.0.0.1 -Port 1883
```

## Khởi tạo database

1. Mở SQL Server Management Studio.
2. Mở `SQLQuery1.sql`.
3. Chạy toàn bộ script.

Script có thể chạy lại. Mỗi lần chạy sẽ xóa các bảng cũ trong `SmartFarmDB`, tạo lại schema và seed dữ liệu demo mới. Không chạy trên database có dữ liệu cần giữ.

## Dữ liệu mẫu

### Tài khoản

Tất cả tài khoản dùng mật khẩu `demo123`.

| Vai trò | Tài khoản | Ghi chú |
|---|---|---|
| OWNER chính | `greenhouse_owner` | Không thể xóa/đổi role |
| OWNER phụ | `owner_secondary` | Dùng test quản lý tài khoản |
| TECHNICIAN | `agronomist` | Test Device, Growth, AUTO Control |
| OPERATOR | `operator_a` | Test Control |
| PENDING | `pending_operator` | Dùng test trạng thái tài khoản |

### Kịch bản Zone

| Zone | Mục đích |
|---|---|
| Zone Hồng A1 - Tối ưu | Sáu metric bình thường, biểu đồ đầy đủ |
| Zone Hồng A2 - Cảnh báo | Nhiệt độ cao, độ ẩm đất thấp, có cảnh báo và AUTO Control |
| Zone Lan B1 - Điều chỉnh | Có điều chỉnh chu kỳ +3 ngày và cảm biến cần thay pin |
| Zone Cúc C1 - Theo dõi | Ánh sáng thấp, có cảnh báo và đèn AUTO |
| Zone C2 - Chờ gieo | Chưa gán Recipe, chưa có ngày bắt đầu |

Mỗi Zone đang hoạt động có đúng 6 SENSOR và 13 điểm lịch sử cho mỗi metric trong 2 giờ gần nhất. Vì vậy Dashboard có dữ liệu ngay sau khi chạy SQL, không cần bật simulator trước.

## Cấu hình backend

Trong `smartfarm-api`, tạo `.env` từ `.env.example`:

```env
DB_HOST=localhost
DB_DATABASE=SmartFarmDB
DB_USER=sa
DB_PASSWORD=your-password
DB_PORT=1433
PORT=5000
MQTT_URL=mqtt://127.0.0.1:1883
SIMULATION_INTERVAL_MS=10000
MQTT_SENSOR_INTERVAL_MS=5000
```

## Chạy ứng dụng

### 1. Backend

```powershell
cd smartfarm-api
npm install
npm start
```

Backend chạy tại `http://localhost:5000` và subscribe:

```text
greenhouse/+/zone/+/sensor/+/data
```

### 2. Sensor MQTT mô phỏng liên tục

Mở PowerShell thứ hai:

```powershell
cd smartfarm-api
npm run mqtt:simulate
```

Simulator đọc SENSOR từ SQL Server, phát toàn bộ cảm biến mỗi 5 giây và định kỳ tạo giá trị bất thường. Dừng bằng `Ctrl+C`.

### 3. Frontend

Mở thư mục gốc bằng VS Code Live Server, hoặc:

```powershell
npx http-server -p 8080
```

Truy cập `http://localhost:8080`. Không mở trực tiếp bằng `file://`.

## MQTT topic và payload

Sensor publish:

```text
greenhouse/{greenhouseId}/zone/{zoneId}/sensor/{deviceId}/data
```

```json
{
  "metricType": "Temperature",
  "value": 25.5,
  "timestamp": "2026-06-21T08:00:00.000Z"
}
```

Backend publish lệnh AUTO:

```text
greenhouse/{greenhouseId}/zone/{zoneId}/device/{deviceId}/command
```

Topic sai Greenhouse/Zone/Device hoặc payload không có `value` hợp lệ sẽ bị từ chối trước khi ghi SensorData.

## Luồng dữ liệu

```text
MQTT Sensor
  → mqtt-service.js
  → processReading()
  → SensorData
  → Threshold của GrowthStage hiện tại
  → AlertLog + Zone.status
  → ControlProperties AUTO
  → MQTT command + Log SYSTEM
```

Khi dữ liệu trở lại trong ngưỡng, cảnh báo AUTO tương ứng chuyển sang `RESOLVED`. Thiết bị MANUAL không bị Rule Engine ghi đè.

## Checklist kiểm thử giao diện

1. Dashboard: chọn từng nhà kính, kiểm tra biểu đồ có dữ liệu và số cảnh báo đúng.
2. Zone: xem Recipe, ngày bắt đầu và thanh tiến độ; Zone C2 hiển thị chưa gán công thức.
3. Growth: chọn Zone áp dụng trong thẻ Recipe, xem 6 ngưỡng, tiến độ và cảnh báo.
4. Device: lọc/sắp xếp, kiểm tra trạng thái ONLINE và NEEDS_REPLACEMENT.
5. Control: kiểm tra AUTO, MANUAL và công suất mẫu.
6. Alerts: có active, acknowledged và dữ liệu resolved trong database.
7. Logs: có cả `USER` và `SYSTEM`, nhiều loại entity.
8. Phân quyền: đăng nhập lần lượt bằng ba vai trò và kiểm tra menu.

## Kiểm thử backend

```powershell
cd smartfarm-api
npm test
npm run test:integration
npm run test:data
npm run test:mqtt
npm run test:seed
npm run test:alerts
```

- `npm test`: cú pháp và hàm logic thuần.
- `test:integration`: SensorData → AlertLog → AUTO Control → Log.
- `test:data`: đủ 6 metric, không có AlertLog mồ côi/trùng và Log sai quan hệ.
- `test:mqtt`: kiểm tra MQTT handler tạo và giải quyết cảnh báo.
- `test:seed`: chạy SQL trên database tạm, kiểm tra dữ liệu Dashboard và tự xóa database tạm.
- `test:alerts`: kiểm tra quan hệ AlertLog → Zone → Greenhouse và ba cấp độ cảnh báo.

## Lưu ý

- Mật khẩu đang lưu dạng văn bản để đơn giản hóa bài tập; hệ thống thật phải dùng bcrypt/Argon2 và JWT/session an toàn.
- `.env` chứa mật khẩu database không nên đưa lên GitHub.
- Sau khi sửa backend, dừng và chạy lại `npm start`.
- Nếu trình duyệt giữ JavaScript cũ, nhấn `Ctrl + F5`.

### Khi MQTT báo sai Zone hoặc trùng khóa SensorData

Nguyên nhân thường là nhiều backend/simulator cũ vẫn chạy sau khi reset SQL. Kiểm tra:

```powershell
Get-Process node
```

Đóng các terminal Node cũ, hoặc nếu chắc chắn không có ứng dụng Node khác cần giữ:

```powershell
Get-Process node | Stop-Process
```

Sau đó chỉ chạy lại hai terminal:

```powershell
# Terminal 1
npm start

# Terminal 2
npm run mqtt:simulate
```

Phiên bản hiện tại dùng MQTT shared subscription, tự tải lại mapping cảm biến mỗi chu kỳ và bỏ qua bản ghi trùng `(device_id, timestamp)`.
