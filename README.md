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

## 1. Phần mềm cần cài

Cài các phần mềm sau:

1. Node.js 18 trở lên: https://nodejs.org
2. Microsoft SQL Server Developer hoặc Express.
3. SQL Server Management Studio (SSMS).
4. Eclipse Mosquitto.
5. Visual Studio Code.

Kiểm tra Node.js:

```powershell
node --version
npm --version
```

Kiểm tra Mosquitto:

```powershell
Get-Service mosquitto
Test-NetConnection 127.0.0.1 -Port 1883
```

Nếu Mosquitto chưa chạy:

```powershell
Start-Service mosquitto
```

## 2. Cài đặt SQL Server

Trong SQL Server Management Studio:

1. Bật **SQL Server and Windows Authentication mode** trong Server Properties -> Security.
2. Khởi động lại SQL Server.
3. Đăng nhập bằng tài khoản quản trị và chạy:

```sql
ALTER LOGIN sa ENABLE;
ALTER LOGIN sa WITH PASSWORD = '123456';
```

Thông tin SQL Server dùng cho project:

```text
Server: localhost
Port: 1433
Login: sa
Password: 123456
Database: SmartFarmDB
```

Nếu `localhost` không kết nối được, thử `localhost\SQLEXPRESS` tùy theo instance đã cài.

Nếu gặp lỗi khác trong quá trình cài đặt hoặc cấu hình SQL Server, bạn có thể hỏi ChatGPT hoặc một công cụ AI khác để tìm cách khắc phục. Nên gửi kèm nội dung thông báo lỗi, phiên bản SQL Server và thao tác vừa thực hiện để nhận hướng dẫn chính xác hơn.

## 3. Tạo database

1. Mở SSMS.
2. Mở file `SQLFinal.sql` ở thư mục gốc project.
3. Kết nối bằng SQL Server Authentication với tài khoản `sa` và mật khẩu `123456`.
4. Nhấn **Execute** để chạy toàn bộ script.

Script sẽ tạo database `SmartFarmDB`, tạo bảng và thêm dữ liệu mẫu. Khi chạy lại, script sẽ xóa dữ liệu demo cũ rồi tạo lại. Không chạy trên database có dữ liệu cần giữ.

## 4. Cấu hình Backend

Mở PowerShell tại thư mục project:

```powershell
cd smartfarm-api
Copy-Item .env.example .env
```

Mở file `smartfarm-api/.env` và đặt:

```env
DB_HOST=localhost
DB_DATABASE=SmartFarmDB
DB_USER=sa
DB_PASSWORD=123456
DB_PORT=1433
PORT=5000
SIMULATION_ENABLED=true
SIMULATION_INTERVAL_MS=10000
MQTT_SENSOR_INTERVAL_MS=5000
MQTT_URL=mqtt://127.0.0.1:1883
```

## 5. Cài thư viện Node.js

Tại thư mục `smartfarm-api`, chạy:

```powershell
npm install
```

Lệnh này tự cài các thư viện trong `package.json`, gồm Express, CORS, dotenv, MQTT, mssql, msnodesqlv8 và nodemon.

## 6. Chạy ứng dụng

Mở ba cửa sổ PowerShell riêng.

### Cửa sổ 1: Backend

```powershell
cd <duong-dan-project>\smartfarm-api
npm start
```

Backend chạy tại `http://localhost:5000`.

### Cửa sổ 2: MQTT Simulator

```powershell
cd <duong-dan-project>\smartfarm-api
npm run mqtt:simulate
```

### Cửa sổ 3: Frontend

Mở thư mục project bằng VS Code và chọn **Open with Live Server**, hoặc chạy:

```powershell
cd <duong-dan-project>
npx http-server -p 8080
```

Mở trình duyệt tại `http://localhost:8080`. Không mở trực tiếp bằng `file://`.

## 7. Tài khoản demo

Các tài khoản mẫu trong ứng dụng dùng mật khẩu `demo123`:

| Vai trò | Tài khoản |
|---|---|
| OWNER | `greenhouse_owner` |
| OWNER phụ | `owner_secondary` |
| TECHNICIAN | `agronomist` |
| OPERATOR | `operator_a` |

Lưu ý: `123456` là mật khẩu SQL Server của tài khoản `sa`; `demo123` là mật khẩu đăng nhập ứng dụng.

## 8. MQTT topic và payload

Sensor gửi dữ liệu:

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

Backend gửi lệnh AUTO:

```text
greenhouse/{greenhouseId}/zone/{zoneId}/device/{deviceId}/command
```

## 9. Kiểm thử

Tại thư mục `smartfarm-api`:

```powershell
npm test
npm run test:integration
npm run test:data
npm run test:mqtt
npm run test:seed
npm run test:alerts
```

## 10. Lỗi thường gặp

### Không kết nối được SQL Server

Kiểm tra SQL Server đang chạy, Mixed Mode đã bật, tài khoản `sa` đã Enable, mật khẩu là `123456` và port là `1433`.

### Không kết nối được MQTT

```powershell
Get-Service mosquitto
Start-Service mosquitto
Test-NetConnection 127.0.0.1 -Port 1883
```

### Dashboard không có dữ liệu

Kiểm tra đã chạy `SQLFinal.sql`, file `.env` đúng thông tin, Mosquitto đang chạy và cửa sổ `npm run mqtt:simulate` không báo lỗi.

### MQTT báo sai Zone hoặc dữ liệu trùng

Đóng các tiến trình Node cũ rồi chạy lại Backend và Simulator:

```powershell
Get-Process node
Stop-Process -Name node
```

Chỉ dùng lệnh trên khi chắc chắn không có ứng dụng Node.js khác đang chạy.

## 11. Lưu ý bảo mật

Mật khẩu `123456` chỉ dùng cho môi trường bài tập/demo. Khi triển khai thật, hãy dùng mật khẩu mạnh, không đưa `.env` lên GitHub và bật cơ chế xác thực an toàn.
