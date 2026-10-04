terraform {
  required_version = ">= 1.5.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {
  # read token from $CLOUDFLARE_API_TOKEN
}

variable "CLOUDFLARE_ACCOUNT_ID" {
  # read account id from $TF_VAR_CLOUDFLARE_ACCOUNT_ID
  type = string
}

variable "enable_do_migration" {
  description = "Set true on the first Worker deployment to create the RemoteChecker SQLite Durable Object namespace"
  type        = bool
  default     = false
}

variable "probe_tokens" {
  description = "JSON object of probe IDs to independent bearer tokens; supplied from GitHub PROBE_TOKENS secret"
  type        = string
  default     = ""
  sensitive   = true
}

variable "admin_password" {
  description = "Web administrator password, supplied through TF_VAR_admin_password"
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.admin_password) >= 16
    error_message = "The administrator password must contain at least 16 characters."
  }
}

variable "admin_session_secret" {
  description = "Independent session-signing secret, supplied through TF_VAR_admin_session_secret"
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.admin_session_secret) >= 32
    error_message = "The session-signing secret must contain at least 32 characters."
  }
}

locals {
  worker_secrets = merge({
    ADMIN_PASSWORD       = var.admin_password
    ADMIN_SESSION_SECRET = var.admin_session_secret
  }, var.probe_tokens == "" ? {} : { PROBE_TOKENS = var.probe_tokens })
  page_secrets = { for name, value in local.worker_secrets : name => {
    type = "secret_text", value = value
  } }
}

resource "cloudflare_d1_database" "uptimeflare_d1" {
  account_id = var.CLOUDFLARE_ACCOUNT_ID
  name       = "uptimeflare_d1"
  read_replication = {
    mode = "auto"
  }
}

resource "cloudflare_workers_script" "uptimeflare_worker" {
  account_id          = var.CLOUDFLARE_ACCOUNT_ID
  script_name         = "uptimeflare_worker"
  main_module         = "worker/dist/index.js"
  content_file        = "worker/dist/index.js"
  content_sha256      = filesha256("worker/dist/index.js")
  compatibility_date  = "2025-04-02"
  compatibility_flags = ["nodejs_compat"]

  observability = {
    enabled = true
    logs = {
      enabled         = true
      invocation_logs = true
    }
  }

  migrations = var.enable_do_migration ? {
    new_tag            = "v1"
    new_sqlite_classes = ["RemoteChecker"]
  } : null

  bindings = concat([{
    name       = "REMOTE_CHECKER_DO"
    class_name = "RemoteChecker"
    type       = "durable_object_namespace"
    }, {
    name = "UPTIMEFLARE_D1"
    type = "d1"
    id   = cloudflare_d1_database.uptimeflare_d1.id
    }], [for name, value in local.worker_secrets : {
    name = name
    type = "secret_text"
    text = value
  }])
}

resource "cloudflare_workers_cron_trigger" "uptimeflare_worker_cron" {
  account_id  = var.CLOUDFLARE_ACCOUNT_ID
  script_name = cloudflare_workers_script.uptimeflare_worker.script_name
  schedules = [{
    cron = "* * * * *" # minute scheduler; each target's interval determines whether a check is due
  }]
}

resource "cloudflare_pages_project" "uptimeflare" {
  account_id        = var.CLOUDFLARE_ACCOUNT_ID
  name              = "uptimeflare"
  production_branch = "main"

  deployment_configs = {
    # SMH Cloudflare provider will throw an error without preview config
    preview = {
      compatibility_date  = "2025-04-02"
      compatibility_flags = ["nodejs_compat"]
      fail_open           = false
    }
    production = {
      env_vars = local.page_secrets
      d1_databases = {
        UPTIMEFLARE_D1 = {
          id = cloudflare_d1_database.uptimeflare_d1.id
        }
      }
      compatibility_date  = "2025-04-02"
      compatibility_flags = ["nodejs_compat"]
      fail_open           = false
    }
  }

  # SMH it will error without this build_config
  build_config = {
    root_dir = "/"
  }
}

output "d1_database_id" {
  description = "Set this ID in both Wrangler D1 bindings before applying SQL migrations"
  value       = cloudflare_d1_database.uptimeflare_d1.id
}

output "pages_project_name" {
  value = cloudflare_pages_project.uptimeflare.name
}
