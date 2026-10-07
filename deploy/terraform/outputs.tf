output "cluster_name" {
  description = "EKS Cluster Name"
  value       = aws_eks_cluster.commerce.name
}

output "cluster_endpoint" {
  description = "EKS Cluster API Endpoint"
  value       = aws_eks_cluster.commerce.endpoint
}

output "cluster_certificate_authority_data" {
  description = "EKS Cluster CA Data"
  value       = aws_eks_cluster.commerce.certificate_authority[0].data
  sensitive   = true
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.commerce_vpc.id
}

output "private_subnet_ids" {
  description = "Private Subnet IDs"
  value       = aws_subnet.private[*].id
}

output "redis_primary_endpoint" {
  description = "Redis Primary Endpoint Address"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}
