CREATE DATABASE IF NOT EXISTS pitill
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE pitill;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pi_uid VARCHAR(191) NOT NULL,
  username VARCHAR(191) NULL,
  role ENUM('shop', 'freelancer') NULL,
  business_name VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_pi_uid (pi_uid)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payment_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_code CHAR(32) NOT NULL,
  merchant_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  client_name VARCHAR(120) NULL,
  due_date DATE NULL,
  status ENUM('pending', 'paid') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_requests_public_code (public_code),
  KEY ix_payment_requests_merchant_created (merchant_id, created_at),
  CONSTRAINT fk_payment_requests_merchant FOREIGN KEY (merchant_id) REFERENCES users (id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id BIGINT UNSIGNED NOT NULL,
  payer_pi_uid VARCHAR(191) NOT NULL,
  pi_payment_id VARCHAR(255) NOT NULL,
  amount DECIMAL(20,8) NOT NULL,
  status ENUM('created', 'approved', 'completed', 'cancelled') NOT NULL DEFAULT 'created',
  txid VARCHAR(255) NULL,
  completed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_pi_payment_id (pi_payment_id),
  KEY ix_payments_request_status (request_id, status),
  KEY ix_payments_payer (payer_pi_uid),
  CONSTRAINT fk_payments_request FOREIGN KEY (request_id) REFERENCES payment_requests (id)
) ENGINE=InnoDB;
