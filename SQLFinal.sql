-- ============================================
-- Script tạo Database SmartFarmDB và chèn dữ liệu mẫu
-- ============================================

IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = N'SmartFarmDB')
BEGIN
    CREATE DATABASE SmartFarmDB;
END;
GO

USE SmartFarmDB;
GO

-- Cho phép chạy lại script để reset toàn bộ dữ liệu demo.
DROP TABLE IF EXISTS AlertLog;
DROP TABLE IF EXISTS [Log];
DROP TABLE IF EXISTS SensorData;
DROP TABLE IF EXISTS Threshold;
DROP TABLE IF EXISTS GrowthStage;
DROP TABLE IF EXISTS ControlProperties;
DROP TABLE IF EXISTS Device;
DROP TABLE IF EXISTS Gateway;
DROP TABLE IF EXISTS Zone;
DROP TABLE IF EXISTS Recipe;
DROP TABLE IF EXISTS Greenhouse;
DROP TABLE IF EXISTS Farm;
DROP TABLE IF EXISTS [User];
GO

-- 3. User (Đã sửa Role thành tiếng Anh và thêm cột status)
CREATE TABLE [User] (
    user_id INT IDENTITY(1,1) PRIMARY KEY,
    user_name NVARCHAR(100) NOT NULL,
    password NVARCHAR(255) NOT NULL,
    email NVARCHAR(100) NOT NULL,
    phone_number NVARCHAR(20),
    role NVARCHAR(30) NOT NULL CHECK (role IN ('OWNER', 'TECHNICIAN', 'OPERATOR')),
    is_primary_owner BIT NOT NULL DEFAULT 0,
    status NVARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'PENDING', 'REJECTED')),
    CONSTRAINT UQ_User_UserName UNIQUE (user_name),
    CONSTRAINT UQ_User_Email UNIQUE (email)
);
GO

CREATE UNIQUE INDEX UX_User_PrimaryOwner ON [User](is_primary_owner) WHERE is_primary_owner = 1;
GO

-- 4. Farm
CREATE TABLE Farm (
    farm_id INT IDENTITY(1,1) PRIMARY KEY,
    owner_id INT NOT NULL,
    address NVARCHAR(MAX),
    farm_name NVARCHAR(100) NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES [User](user_id)
);
GO

-- 5. Greenhouse
CREATE TABLE Greenhouse (
    greenhouse_id INT IDENTITY(1,1) PRIMARY KEY,
    farm_id INT NOT NULL,
    greenhouse_name NVARCHAR(100) NOT NULL,
    location_gps NVARCHAR(100),
    FOREIGN KEY (farm_id) REFERENCES Farm(farm_id)
);
GO

-- 6. Recipe
CREATE TABLE Recipe (
    recipe_id INT IDENTITY(1,1) PRIMARY KEY,
    creator INT NOT NULL,
    recipe_name NVARCHAR(100) NOT NULL,
    flower_type NVARCHAR(100),
    description NVARCHAR(MAX),
    status NVARCHAR(20) NOT NULL DEFAULT N'active' CHECK (status IN (N'active', N'delayed', N'completed')),
    created_date DATE NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (creator) REFERENCES [User](user_id)
);
GO

-- 7. Zone (Đã thêm temperature, humidity, status)
CREATE TABLE Zone (
    zone_id INT IDENTITY(1,1) PRIMARY KEY,
    greenhouse_id INT NOT NULL,
    recipe_id INT NULL,
    zone_name NVARCHAR(100) NOT NULL,
    start_date DATE,
    temperature DECIMAL(5,2) NULL,
    humidity INT NULL,
    status NVARCHAR(20) NULL,
    cycle_adjustment_days INT NOT NULL DEFAULT 0 CHECK (cycle_adjustment_days >= 0),
    adjustment_reason NVARCHAR(255) NULL,
    FOREIGN KEY (greenhouse_id) REFERENCES Greenhouse(greenhouse_id),
    FOREIGN KEY (recipe_id) REFERENCES Recipe(recipe_id)
);
GO

-- 8. Gateway
CREATE TABLE Gateway (
    gateway_id INT IDENTITY(1,1) PRIMARY KEY,
    greenhouse_id INT NOT NULL,
    status NVARCHAR(20) NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE', 'MAINTENANCE')),
    gateway_address NVARCHAR(100),
    FOREIGN KEY (greenhouse_id) REFERENCES Greenhouse(greenhouse_id)
);
GO

-- 9. Device
CREATE TABLE Device (
    device_id INT IDENTITY(1,1) PRIMARY KEY,
    gateway_id INT NOT NULL,
    zone_id INT NOT NULL,
    device_name NVARCHAR(100) NOT NULL,
    device_type NVARCHAR(20) NOT NULL CHECK (device_type IN ('SENSOR', 'OUTPUT_DEVICE')),
    metric_type NVARCHAR(50) NOT NULL,
    mac_address NVARCHAR(17) NULL,
    battery_level INT NULL,
    status NVARCHAR(20) NOT NULL CHECK (status IN ('ONLINE', 'OFFLINE', 'ERROR', 'NEEDS_REPLACEMENT')) DEFAULT 'ONLINE',
    last_heartbeat DATETIME2 NOT NULL DEFAULT GETDATE(),
    CHECK (battery_level IS NULL OR battery_level BETWEEN 0 AND 100),
    FOREIGN KEY (gateway_id) REFERENCES Gateway(gateway_id),
    FOREIGN KEY (zone_id) REFERENCES Zone(zone_id)
);
GO

-- SQL Server UNIQUE constraint chi cho phep mot NULL; filtered index phu hop hon cho MAC tuy chon.
CREATE UNIQUE INDEX UX_Device_MacAddress
ON Device(mac_address)
WHERE mac_address IS NOT NULL;
GO

-- 10. ControlProperties
CREATE TABLE ControlProperties (
    device_id INT PRIMARY KEY,
    mode NVARCHAR(10) NOT NULL CHECK (mode IN ('AUTO', 'MANUAL')),
    is_active BIT NOT NULL DEFAULT 0,
    value_percent INT NOT NULL DEFAULT 0 CHECK (value_percent BETWEEN 0 AND 100),
    auto_reset_time DATETIME2 NULL,
    FOREIGN KEY (device_id) REFERENCES Device(device_id) ON DELETE CASCADE
);
GO

-- 11. GrowthStage
CREATE TABLE GrowthStage (
    stage_id INT IDENTITY(1,1) PRIMARY KEY,
    recipe_id INT NOT NULL,
    stage_name NVARCHAR(100) NOT NULL,
    start_day INT NOT NULL,
    end_day INT NOT NULL,
    completed BIT NOT NULL DEFAULT 0,
    current_day INT NULL,
    CHECK (start_day >= 0 AND end_day >= start_day),
    CHECK (current_day IS NULL OR current_day >= 0),
    FOREIGN KEY (recipe_id) REFERENCES Recipe(recipe_id)
);
GO

-- 12. Threshold
CREATE TABLE Threshold (
    threshold_id INT IDENTITY(1,1) PRIMARY KEY,
    stage_id INT NOT NULL,
    metric_type NVARCHAR(50) NOT NULL,
    min_value DECIMAL(10,2),
    max_value DECIMAL(10,2),
    CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
    FOREIGN KEY (stage_id) REFERENCES GrowthStage(stage_id)
);
GO

-- 13. SensorData
CREATE TABLE SensorData (
    device_id INT NOT NULL,
    [timestamp] DATETIME2 NOT NULL,
    raw_value DECIMAL(10,2) NOT NULL,
    PRIMARY KEY (device_id, [timestamp]),
    FOREIGN KEY (device_id) REFERENCES Device(device_id)
);
GO

-- 14. Log
CREATE TABLE [Log] (
    log_id INT IDENTITY(1,1) PRIMARY KEY,
    device_id INT NULL,
    user_id INT NULL,
    entity_type NVARCHAR(20) NOT NULL DEFAULT 'DEVICE'
        CHECK (entity_type IN ('DEVICE', 'ZONE', 'GREENHOUSE', 'FARM',
            'RECIPE', 'GROWTH_STAGE', 'ALERT', 'USER', 'SIMULATION')),
    entity_id INT NULL,
    action NVARCHAR(255) NOT NULL,
    triggered_by NVARCHAR(10) NOT NULL CHECK (triggered_by IN ('USER', 'SYSTEM')),
    log_time DATETIME2 NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (device_id) REFERENCES Device(device_id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES [User](user_id),
    CHECK ((triggered_by = 'SYSTEM' AND user_id IS NULL) OR (triggered_by = 'USER' AND user_id IS NOT NULL))
);
GO

-- 15. AlertLog
CREATE TABLE AlertLog (
    alert_id INT IDENTITY(1,1) PRIMARY KEY,
    zone_id INT NOT NULL,
    message NVARCHAR(MAX) NOT NULL,
    severity NVARCHAR(20) NOT NULL CHECK (severity IN ('SIGNIFICANT', 'WARNING', 'CRITICAL')),
    status NVARCHAR(20) NOT NULL CHECK (status IN ('UNSOLVED', 'ACKNOWLEDGED', 'RESOLVED')) DEFAULT 'UNSOLVED',
    created_at DATETIME2 DEFAULT GETDATE(),
    resolved_at DATETIME2 NULL,
    acknowledged_by NVARCHAR(100) NULL,
    escalation_level INT NOT NULL DEFAULT 0,
    FOREIGN KEY (zone_id) REFERENCES Zone(zone_id)
);
GO

-- ============================================
-- CHÈN DỮ LIỆU MẪU 
-- ============================================

-- 1. Tài khoản: đủ vai trò để kiểm thử phân quyền và quản lý tài khoản.
SET IDENTITY_INSERT [User] ON;
INSERT INTO [User] (user_id, user_name, password, email, phone_number, role, status) VALUES
(1, 'greenhouse_owner', 'demo123', 'owner@greenhouse.local', '0901000001', 'OWNER', 'ACTIVE'),
(2, 'owner_secondary', 'demo123', 'owner2@greenhouse.local', '0901000002', 'OWNER', 'ACTIVE'),
(3, 'agronomist', 'demo123', 'tech@greenhouse.local', '0901000003', 'TECHNICIAN', 'ACTIVE'),
(4, 'operator_a', 'demo123', 'operator@greenhouse.local', '0901000004', 'OPERATOR', 'ACTIVE'),
(5, 'pending_operator', 'demo123', 'pending@greenhouse.local', '0901000005', 'OPERATOR', 'PENDING');
SET IDENTITY_INSERT [User] OFF;
UPDATE [User] SET is_primary_owner = 1 WHERE user_id = 1;
GO

-- 2. Farm
SET IDENTITY_INSERT Farm ON;
INSERT INTO Farm (farm_id, owner_id, address, farm_name) VALUES
(1, 1, N'Phường 8, Đà Lạt', N'Trang trại Hoa Đà Lạt'),
(2, 2, N'Xã Xuân Thọ, Đà Lạt', N'Trang trại Trình diễn IoT');
SET IDENTITY_INSERT Farm OFF;
GO

-- 3. Greenhouse
SET IDENTITY_INSERT Greenhouse ON;
INSERT INTO Greenhouse (greenhouse_id, farm_id, greenhouse_name, location_gps) VALUES
(1, 1, N'Nhà kính Hoa Hồng', '11.9404,108.4583'),
(2, 1, N'Nhà kính Hoa Lan', '11.9410,108.4590'),
(3, 2, N'Nhà kính Hoa Cúc', '11.9500,108.4700');
SET IDENTITY_INSERT Greenhouse OFF;
GO

-- 4. Recipe
SET IDENTITY_INSERT Recipe ON;
INSERT INTO Recipe (recipe_id, creator, recipe_name, flower_type, description, status, created_date) VALUES
(1, 3, N'Hoa Hồng tiêu chuẩn', N'Hoa Hồng', N'Ba giai đoạn, đủ sáu ngưỡng môi trường.', N'active', GETDATE()),
(2, 3, N'Hoa Lan độ ẩm cao', N'Hoa Lan', N'Ưu tiên độ ẩm không khí và độ ẩm đất cao.', N'active', GETDATE()),
(3, 3, N'Hoa Cúc thương phẩm', N'Hoa Cúc', N'Công thức kiểm thử ánh sáng và CO2.', N'active', GETDATE());
SET IDENTITY_INSERT Recipe OFF;
GO

-- 5. Zone: có vùng tối ưu, vùng cảnh báo, vùng đã điều chỉnh chu kỳ và vùng chưa gán công thức.
SET IDENTITY_INSERT Zone ON;
INSERT INTO Zone (zone_id, greenhouse_id, recipe_id, zone_name, start_date, temperature, humidity, status, cycle_adjustment_days, adjustment_reason) VALUES
(1, 1, 1, N'Zone Hồng A1 - Tối ưu', DATEADD(DAY, -18, CAST(GETDATE() AS DATE)), 25.2, 70, 'optimal', 0, NULL),
(2, 1, 1, N'Zone Hồng A2 - Cảnh báo', DATEADD(DAY, -8, CAST(GETDATE() AS DATE)), 31.5, 48, 'high', 0, NULL),
(3, 2, 2, N'Zone Lan B1 - Điều chỉnh', DATEADD(DAY, -25, CAST(GETDATE() AS DATE)), 24.0, 82, 'optimal', 3, N'Kéo dài giai đoạn phát triển rễ do cây sinh trưởng chậm.'),
(4, 3, 3, N'Zone Cúc C1 - Theo dõi', DATEADD(DAY, -15, CAST(GETDATE() AS DATE)), 26.5, 68, 'warning', 0, NULL),
(5, 3, NULL, N'Zone C2 - Chờ gieo', NULL, NULL, NULL, 'inactive', 0, NULL);
SET IDENTITY_INSERT Zone OFF;
GO

-- 6. Gateway
SET IDENTITY_INSERT Gateway ON;
INSERT INTO Gateway (gateway_id, greenhouse_id, status, gateway_address) VALUES
(1, 1, 'ONLINE', 'mqtt://192.168.10.11'),
(2, 2, 'ONLINE', 'mqtt://192.168.10.12'),
(3, 3, 'ONLINE', 'mqtt://192.168.10.13');
SET IDENTITY_INSERT Gateway OFF;
GO

-- 7. Device
SET IDENTITY_INSERT Device ON;
INSERT INTO Device (device_id, gateway_id, zone_id, device_name, device_type, metric_type, mac_address, battery_level, status, last_heartbeat) VALUES
(1,1,1,N'Nhiệt độ Hồng A1','SENSOR','Temperature','02:00:00:00:01:01',88,'ONLINE',GETDATE()),
(2,1,1,N'Độ ẩm không khí Hồng A1','SENSOR','Humidity','02:00:00:00:01:02',86,'ONLINE',GETDATE()),
(3,1,1,N'Ánh sáng Hồng A1','SENSOR','Light','02:00:00:00:01:03',84,'ONLINE',GETDATE()),
(4,1,1,N'Độ ẩm đất Hồng A1','SENSOR','SoilHumidity','02:00:00:00:01:04',82,'ONLINE',GETDATE()),
(5,1,1,N'pH Hồng A1','SENSOR','PH','02:00:00:00:01:05',80,'ONLINE',GETDATE()),
(6,1,1,N'CO2 Hồng A1','SENSOR','CO2','02:00:00:00:01:06',78,'ONLINE',GETDATE()),
(7,1,2,N'Nhiệt độ Hồng A2','SENSOR','Temperature','02:00:00:00:02:01',72,'ONLINE',GETDATE()),
(8,1,2,N'Độ ẩm không khí Hồng A2','SENSOR','Humidity','02:00:00:00:02:02',70,'ONLINE',GETDATE()),
(9,1,2,N'Ánh sáng Hồng A2','SENSOR','Light','02:00:00:00:02:03',68,'ONLINE',GETDATE()),
(10,1,2,N'Độ ẩm đất Hồng A2','SENSOR','SoilHumidity','02:00:00:00:02:04',66,'ONLINE',GETDATE()),
(11,1,2,N'pH Hồng A2','SENSOR','PH','02:00:00:00:02:05',64,'ONLINE',GETDATE()),
(12,1,2,N'CO2 Hồng A2','SENSOR','CO2','02:00:00:00:02:06',62,'ONLINE',GETDATE()),
(13,2,3,N'Nhiệt độ Lan B1','SENSOR','Temperature','02:00:00:00:03:01',92,'ONLINE',GETDATE()),
(14,2,3,N'Độ ẩm không khí Lan B1','SENSOR','Humidity','02:00:00:00:03:02',90,'ONLINE',GETDATE()),
(15,2,3,N'Ánh sáng Lan B1','SENSOR','Light','02:00:00:00:03:03',88,'ONLINE',GETDATE()),
(16,2,3,N'Độ ẩm đất Lan B1','SENSOR','SoilHumidity','02:00:00:00:03:04',86,'ONLINE',GETDATE()),
(17,2,3,N'pH Lan B1','SENSOR','PH','02:00:00:00:03:05',9,'NEEDS_REPLACEMENT',DATEADD(MINUTE,-3,GETDATE())),
(18,2,3,N'CO2 Lan B1','SENSOR','CO2','02:00:00:00:03:06',84,'ONLINE',GETDATE()),
(19,3,4,N'Nhiệt độ Cúc C1','SENSOR','Temperature','02:00:00:00:04:01',76,'ONLINE',GETDATE()),
(20,3,4,N'Độ ẩm không khí Cúc C1','SENSOR','Humidity','02:00:00:00:04:02',74,'ONLINE',GETDATE()),
(21,3,4,N'Ánh sáng Cúc C1','SENSOR','Light','02:00:00:00:04:03',72,'ONLINE',GETDATE()),
(22,3,4,N'Độ ẩm đất Cúc C1','SENSOR','SoilHumidity','02:00:00:00:04:04',70,'ONLINE',GETDATE()),
(23,3,4,N'pH Cúc C1','SENSOR','PH','02:00:00:00:04:05',68,'ONLINE',GETDATE()),
(24,3,4,N'CO2 Cúc C1','SENSOR','CO2','02:00:00:00:04:06',66,'ONLINE',GETDATE()),
(25,1,1,N'Bơm tưới Hồng A1','OUTPUT_DEVICE','Irrigation','02:00:00:00:01:11',NULL,'ONLINE',GETDATE()),
(26,1,1,N'Quạt thông gió Hồng A1','OUTPUT_DEVICE','Ventilation','02:00:00:00:01:12',NULL,'ONLINE',GETDATE()),
(27,1,2,N'Bơm tưới Hồng A2','OUTPUT_DEVICE','Irrigation','02:00:00:00:02:11',NULL,'ONLINE',GETDATE()),
(28,1,2,N'Quạt thông gió Hồng A2','OUTPUT_DEVICE','Ventilation','02:00:00:00:02:12',NULL,'ONLINE',GETDATE()),
(29,1,2,N'Phun sương Hồng A2','OUTPUT_DEVICE','Misting','02:00:00:00:02:13',NULL,'ONLINE',GETDATE()),
(30,2,3,N'Phun sương Lan B1','OUTPUT_DEVICE','Misting','02:00:00:00:03:11',NULL,'ONLINE',GETDATE()),
(31,2,3,N'Quạt thông gió Lan B1','OUTPUT_DEVICE','Ventilation','02:00:00:00:03:12',NULL,'ONLINE',GETDATE()),
(32,3,4,N'Đèn sinh trưởng Cúc C1','OUTPUT_DEVICE','Lighting','02:00:00:00:04:11',NULL,'ONLINE',GETDATE()),
(33,3,4,N'Quạt thông gió Cúc C1','OUTPUT_DEVICE','Ventilation','02:00:00:00:04:12',NULL,'ONLINE',GETDATE());
SET IDENTITY_INSERT Device OFF;
GO

-- 8. ControlProperties
INSERT INTO ControlProperties (device_id, mode, is_active, value_percent, auto_reset_time) VALUES
(25,'AUTO',0,0,NULL),(26,'AUTO',0,0,NULL),
(27,'AUTO',1,80,NULL),(28,'AUTO',1,80,NULL),(29,'MANUAL',1,65,DATEADD(MINUTE,90,GETDATE())),
(30,'AUTO',0,0,NULL),(31,'AUTO',0,0,NULL),
(32,'AUTO',1,70,NULL),(33,'AUTO',0,0,NULL);
GO

-- 9. GrowthStage (cho từng recipe)
SET IDENTITY_INSERT GrowthStage ON;
INSERT INTO GrowthStage (stage_id, recipe_id, stage_name, start_day, end_day, completed, current_day) VALUES
(1, 1, N'Ươm cây', 1, 10, 1, 10),
(2, 1, N'Phát triển thân lá', 11, 25, 0, 8),
(3, 1, N'Ra nụ và nở hoa', 26, 45, 0, NULL),
(4, 2, N'Ổn định cây con', 1, 14, 1, 14),
(5, 2, N'Phát triển rễ và lá', 15, 35, 0, 11),
(6, 2, N'Ra hoa', 36, 60, 0, NULL),
(7, 3, N'Ươm cây thử nghiệm', 1, 12, 0, NULL),
(8, 3, N'Phát triển thử nghiệm', 13, 30, 0, NULL);
SET IDENTITY_INSERT GrowthStage OFF;
GO

-- 10. Threshold (cho từng stage)
SET IDENTITY_INSERT Threshold ON;
INSERT INTO Threshold (threshold_id, stage_id, metric_type, min_value, max_value) VALUES
(1,1,'Temperature',22,26),(2,1,'Humidity',65,80),(3,1,'Light',8000,18000),(4,1,'SoilHumidity',65,80),(5,1,'PH',5.8,6.8),(6,1,'CO2',500,900),
(7,2,'Temperature',23,28),(8,2,'Humidity',60,75),(9,2,'Light',12000,25000),(10,2,'SoilHumidity',60,75),(11,2,'PH',5.8,6.8),(12,2,'CO2',600,1000),
(13,3,'Temperature',20,26),(14,3,'Humidity',55,70),(15,3,'Light',15000,30000),(16,3,'SoilHumidity',55,70),(17,3,'PH',5.8,6.8),(18,3,'CO2',600,1100),
(19,4,'Temperature',22,26),(20,4,'Humidity',75,90),(21,4,'Light',6000,14000),(22,4,'SoilHumidity',70,85),(23,4,'PH',5.5,6.5),(24,4,'CO2',500,900),
(25,5,'Temperature',23,27),(26,5,'Humidity',70,88),(27,5,'Light',8000,18000),(28,5,'SoilHumidity',65,80),(29,5,'PH',5.5,6.5),(30,5,'CO2',550,950),
(31,6,'Temperature',21,25),(32,6,'Humidity',70,85),(33,6,'Light',10000,22000),(34,6,'SoilHumidity',60,75),(35,6,'PH',5.5,6.5),(36,6,'CO2',600,1000),
(37,7,'Temperature',20,27),(38,7,'Humidity',60,80),(39,7,'Light',7000,16000),(40,7,'SoilHumidity',55,75),(41,7,'PH',5.8,6.8),(42,7,'CO2',500,900),
(43,8,'Temperature',21,28),(44,8,'Humidity',55,75),(45,8,'Light',10000,24000),(46,8,'SoilHumidity',50,70),(47,8,'PH',5.8,6.8),(48,8,'CO2',600,1000);
SET IDENTITY_INSERT Threshold OFF;
GO

-- 11. SensorData: 13 điểm/metric trong 2 giờ, đủ dữ liệu cho mọi biểu đồ Dashboard.
INSERT INTO SensorData (device_id, [timestamp], raw_value)
SELECT d.device_id,
       DATEADD(MINUTE, -10 * sample.offset_no, DATEADD(SECOND, -d.device_id, GETDATE())),
       CAST(CASE d.metric_type
         WHEN 'Temperature' THEN CASE WHEN d.zone_id = 2 THEN 31.5 - sample.offset_no * 0.08 ELSE 24.5 + d.zone_id * 0.35 + sample.offset_no * 0.03 END
         WHEN 'Humidity' THEN CASE WHEN d.zone_id = 2 THEN 48 + sample.offset_no * 0.2 ELSE 68 + d.zone_id * 2 + sample.offset_no * 0.1 END
         WHEN 'Light' THEN CASE WHEN d.zone_id = 4 THEN 6500 + sample.offset_no * 120 ELSE 13000 + d.zone_id * 900 + sample.offset_no * 80 END
         WHEN 'SoilHumidity' THEN CASE WHEN d.zone_id = 2 THEN 45 + sample.offset_no * 0.15 ELSE 64 + d.zone_id * 2 + sample.offset_no * 0.08 END
         WHEN 'PH' THEN 6.1 + d.zone_id * 0.05 + sample.offset_no * 0.005
         WHEN 'CO2' THEN CASE WHEN d.zone_id = 2 THEN 1150 - sample.offset_no * 5 ELSE 650 + d.zone_id * 45 + sample.offset_no * 2 END
       END AS DECIMAL(10,2))
FROM Device d
CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12)) sample(offset_no)
WHERE d.device_type = 'SENSOR';
GO

-- 12. AlertLog: du muc do va trang thai xu ly
SET IDENTITY_INSERT AlertLog ON;
INSERT INTO AlertLog (alert_id, zone_id, message, severity, status, created_at, resolved_at, acknowledged_by, escalation_level) VALUES
(1,2,N'[AUTO:Temperature] Nhiệt độ Hồng A2 tại Zone Hồng A2 - Cảnh báo: 31.5 cao hơn ngưỡng 26. Nguồn: SEED.','CRITICAL','UNSOLVED',DATEADD(MINUTE,-12,GETDATE()),NULL,NULL,2),
(2,2,N'[AUTO:SoilHumidity] Độ ẩm đất Hồng A2 tại Zone Hồng A2 - Cảnh báo: 45 thấp hơn ngưỡng 65. Nguồn: SEED.','WARNING','ACKNOWLEDGED',DATEADD(MINUTE,-25,GETDATE()),NULL,N'operator_a',1),
(3,4,N'[AUTO:Light] Ánh sáng Cúc C1 tại Zone Cúc C1 - Theo dõi: 6500 thấp hơn ngưỡng 10000. Nguồn: SEED.','WARNING','UNSOLVED',DATEADD(MINUTE,-8,GETDATE()),NULL,NULL,1),
(4,3,N'Pin cảm biến pH Lan B1 chỉ còn 9%, cần thay pin.','SIGNIFICANT','UNSOLVED',DATEADD(MINUTE,-5,GETDATE()),NULL,NULL,0),
(5,1,N'[AUTO:Temperature] Cảnh báo nhiệt độ cũ đã trở lại bình thường.','WARNING','RESOLVED',DATEADD(HOUR,-3,GETDATE()),DATEADD(HOUR,-2,GETDATE()),N'operator_a',1);
SET IDENTITY_INSERT AlertLog OFF;
GO

-- 13. Log: thao tac USER va dieu khien SYSTEM
SET IDENTITY_INSERT [Log] ON;
INSERT INTO [Log] (log_id, device_id, user_id, entity_type, entity_id, action, triggered_by, log_time) VALUES
(1,NULL,1,'USER',1,N'Tài khoản greenhouse_owner đăng nhập.','USER',DATEADD(HOUR,-2,GETDATE())),
(2,NULL,3,'RECIPE',1,N'Cập nhật công thức Hoa Hồng tiêu chuẩn.','USER',DATEADD(MINUTE,-90,GETDATE())),
(3,NULL,3,'ZONE',3,N'Điều chỉnh chu kỳ Zone Lan B1 thêm 3 ngày.','USER',DATEADD(MINUTE,-70,GETDATE())),
(4,29,4,'DEVICE',29,N'Chuyển Phun sương Hồng A2 sang MANUAL ở mức 65%.','USER',DATEADD(MINUTE,-30,GETDATE())),
(5,28,NULL,'DEVICE',28,N'Tự động bật Quạt thông gió Hồng A2 do Temperature high.','SYSTEM',DATEADD(MINUTE,-12,GETDATE())),
(6,27,NULL,'DEVICE',27,N'Tự động bật Bơm tưới Hồng A2 do SoilHumidity low.','SYSTEM',DATEADD(MINUTE,-11,GETDATE())),
(7,NULL,1,'ALERT',2,N'Xác nhận cảnh báo độ ẩm đất tại Zone Hồng A2.','USER',DATEADD(MINUTE,-10,GETDATE())),
(8,32,NULL,'DEVICE',32,N'Tự động bật Đèn sinh trưởng Cúc C1 do Light low.','SYSTEM',DATEADD(MINUTE,-8,GETDATE())),
(9,NULL,1,'SIMULATION',NULL,N'Bật mô phỏng MQTT với chu kỳ 5 giây.','USER',DATEADD(MINUTE,-5,GETDATE()));
SET IDENTITY_INSERT [Log] OFF;
GO
