$services = @(
  "api-gateway",
  "users-service",
  "catalog-service",
  "inventory-service",
  "orders-service",
  "payments-service",
  "cart-service",
  "pricing-service",
  "shipping-service",
  "search-service",
  "reviews-service",
  "recommendations-service"
)

foreach ($s in $services) {
  Write-Host "=== Building production image: commerce-$s:prod ===" -ForegroundColor Cyan
  docker build --target production -t "commerce-$($s):prod" -f "apps/$s/Dockerfile" .
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to build $s"
    exit 1
  }
}

Write-Host "=== All 12 production images built successfully! ===" -ForegroundColor Green
Write-Host "Importing into k3d-commerce-cluster..." -ForegroundColor Cyan

$images = $services | ForEach-Object { "commerce-$($_):prod" }
k3d image import $images -c commerce-cluster --mode direct

Write-Host "=== All images imported into cluster nodes! ===" -ForegroundColor Green
