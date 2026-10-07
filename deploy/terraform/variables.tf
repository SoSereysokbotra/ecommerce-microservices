variable "aws_region" {
  description = "AWS region for the e-commerce infrastructure"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name (e.g., staging, production)"
  type        = string
  default     = "production"
}

variable "cluster_name" {
  description = "EKS Cluster Name"
  type        = string
  default     = "commerce-eks-cluster"
}

variable "vpc_cidr" {
  description = "VPC CIDR block"
  type        = string
  default     = "10.0.0.0/16"
}

variable "node_instance_types" {
  description = "EC2 instance types for EKS worker nodes"
  type        = list(string)
  default     = ["t3.xlarge"]
}

variable "min_node_count" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = 3
}

variable "max_node_count" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = 10
}

variable "desired_node_count" {
  description = "Desired number of worker nodes"
  type        = number
  default     = 3
}

variable "db_instance_class" {
  description = "RDS instance class for microservices PostgreSQL"
  type        = string
  default     = "db.t4g.medium"
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.t4g.medium"
}
