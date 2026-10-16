'use client';

import React, { useEffect, useState } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { api, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/formatters';

interface ProductItem {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description?: string | null;
  priceMinor: number;
  currency: string;
  weightGrams: number;
  categoryId?: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CategoryItem {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
}

interface PaginatedProductsResponse {
  data: ProductItem[];
  nextCursor?: string | null;
}

export default function CatalogPage() {
  const [products, setProducts] = useState<ProductItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'crit'; text: string } | null>(null);

  // Filters
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [search, setSearch] = useState<string>('');

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingProduct, setEditingProduct] = useState<ProductItem | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  // Form Fields
  const [formSku, setFormSku] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPrice, setFormPrice] = useState('19.99');
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formWeight, setFormWeight] = useState('0');
  const [formCategoryId, setFormCategoryId] = useState('');
  const [formActive, setFormActive] = useState(true);

  // Category Edit Modal State
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<CategoryItem | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryDesc, setCategoryDesc] = useState('');
  const [categorySaving, setCategorySaving] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [productsRes, categoriesRes] = await Promise.all([
        api.get<PaginatedProductsResponse>('/catalog/products?limit=100&active=true'),
        api.get<CategoryItem[]>('/catalog/categories'),
      ]);
      setProducts(productsRes.data || []);
      setCategories(categoriesRes || []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load catalog data';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([
      api.get<PaginatedProductsResponse>('/catalog/products?limit=100&active=true'),
      api.get<CategoryItem[]>('/catalog/categories'),
    ])
      .then(([productsRes, categoriesRes]) => {
        if (!mounted) return;
        setProducts(productsRes.data || []);
        setCategories(categoriesRes || []);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Failed to load catalog data';
        setFeedback({ type: 'crit', text: msg });
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const openCreateModal = () => {
    setEditingProduct(null);
    setFormSku('');
    setFormSlug('');
    setFormName('');
    setFormDescription('');
    setFormPrice('19.99');
    setFormCurrency('USD');
    setFormWeight('0');
    setFormCategoryId(categories[0]?.id || '');
    setFormActive(true);
    setIsModalOpen(true);
  };

  const openEditModal = (p: ProductItem) => {
    setEditingProduct(p);
    setFormSku(p.sku);
    setFormSlug(p.slug);
    setFormName(p.name);
    setFormDescription(p.description || '');
    setFormPrice((p.priceMinor / 100).toFixed(2));
    setFormCurrency(p.currency);
    setFormWeight(String(p.weightGrams || 0));
    setFormCategoryId(p.categoryId || '');
    setFormActive(p.active);
    setIsModalOpen(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);

    const priceMinor = Math.round(parseFloat(formPrice || '0') * 100);
    const weightGrams = parseInt(formWeight || '0', 10);

    try {
      if (editingProduct) {
        // Update product
        await api.patch(`/catalog/products/${editingProduct.id}`, {
          name: formName,
          description: formDescription || null,
          priceMinor,
          currency: formCurrency.toUpperCase(),
          weightGrams,
          categoryId: formCategoryId || null,
          active: formActive,
        });
        setFeedback({ type: 'ok', text: `Product "${formName}" updated successfully.` });
      } else {
        // Create product
        const slug =
          formSlug ||
          formName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)+/g, '');

        await api.post('/catalog/products', {
          sku: formSku,
          slug,
          name: formName,
          description: formDescription || null,
          priceMinor,
          currency: formCurrency.toUpperCase(),
          weightGrams,
          categoryId: formCategoryId || null,
          active: formActive,
        });
        setFeedback({ type: 'ok', text: `Product "${formName}" created successfully.` });
      }

      setIsModalOpen(false);
      loadData();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to save product';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setSaving(false);
    }
  };

  const openCategoryEdit = (cat: CategoryItem) => {
    setEditingCategory(cat);
    setCategoryName(cat.name);
    setCategoryDesc(cat.description || '');
    setIsCategoryModalOpen(true);
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCategory) return;
    setCategorySaving(true);
    try {
      await api.patch(`/catalog/categories/${editingCategory.id}`, {
        name: categoryName,
        description: categoryDesc || null,
      });
      setFeedback({ type: 'ok', text: `Category "${categoryName}" updated successfully.` });
      setIsCategoryModalOpen(false);
      loadData();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'Failed to update category';
      setFeedback({ type: 'crit', text: msg });
    } finally {
      setCategorySaving(false);
    }
  };

  // Filter products by category and search
  const filteredProducts = products.filter((p) => {
    if (selectedCategory && p.categoryId !== selectedCategory) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const getCategoryName = (catId?: string | null) => {
    if (!catId) return 'Uncategorized';
    const c = categories.find((cat) => cat.id === catId);
    return c ? c.name : 'Unknown';
  };

  return (
    <AuthGate>
      <div className="stack" style={{ gap: '1.75rem' }}>
        {/* Header Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div>
            <div className="row" style={{ gap: '0.75rem', marginBottom: '0.25rem' }}>
              <h1>Product Catalog Management</h1>
              <span className="pill pill-staff">{products.length} Products</span>
            </div>
            <p className="subtitle">
              Author products, assign categories, maintain pricing, and define weights.
            </p>
          </div>

          <div className="row" style={{ gap: '0.75rem' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={loadData}
              disabled={loading}
              id="btn-refresh-catalog"
              style={{ fontSize: '0.8rem' }}
            >
              {loading ? 'Refreshing…' : '↻ Refresh'}
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={openCreateModal}
              id="btn-add-product"
              style={{ fontSize: '0.8rem' }}
            >
              + Create Product
            </button>
          </div>
        </div>

        {/* Feedback Alert */}
        {feedback && (
          <div
            className={`alert-notice ${feedback.type === 'ok' ? 'alert-ok' : 'alert-crit'}`}
            id="catalog-feedback-alert"
          >
            <span>{feedback.text}</span>
          </div>
        )}

        {/* Categories Bar */}
        <div className="card" style={{ padding: '1rem 1.25rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
              Managed Categories ({categories.length})
            </span>
          </div>
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            {categories.map((cat) => (
              <span
                key={cat.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  padding: '0.3rem 0.65rem',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--line-subtle)',
                  fontSize: '0.8rem',
                }}
              >
                <span>{cat.name}</span>
                <button
                  type="button"
                  onClick={() => openCategoryEdit(cat)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-primary)',
                    cursor: 'pointer',
                    padding: '0',
                    fontSize: '0.75rem',
                  }}
                  title="Rename Category"
                >
                  ✎
                </button>
              </span>
            ))}
          </div>
        </div>

        {/* Filters Toolbar */}
        <div className="card filter-toolbar">
          <div className="search-input-wrapper">
            <input
              type="text"
              id="input-product-search"
              placeholder="Search product name, SKU, or slug…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>

          <div className="row" style={{ gap: '0.75rem' }}>
            <select
              id="select-category-filter"
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
            >
              <option value="">All Categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Products Table */}
        <div className="table-container" data-testid="products-table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>Category</th>
                <th>Price</th>
                <th>Weight</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && products.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '3rem' }}>
                    <p className="subtitle">Loading catalog products…</p>
                  </td>
                </tr>
              ) : filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '3rem' }}>
                    <p className="subtitle">No products found matching filters.</p>
                  </td>
                </tr>
              ) : (
                filteredProducts.map((p) => (
                  <tr key={p.id} id={`product-row-${p.id}`}>
                    <td>
                      <code style={{ fontSize: '0.8rem', color: 'var(--accent-secondary)' }}>
                        {p.sku}
                      </code>
                    </td>
                    <td>
                      <div>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}>
                          /{p.slug}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="pill pill-staff" style={{ fontSize: '0.72rem' }}>
                        {getCategoryName(p.categoryId)}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {formatMoney(p.priceMinor, p.currency)}
                    </td>
                    <td style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {p.weightGrams ? `${p.weightGrams}g` : '0g'}
                    </td>
                    <td>
                      <span className={`pill ${p.active ? 'pill-ok' : 'pill-crit'}`}>
                        {p.active ? 'Active' : 'Draft / Inactive'}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => openEditModal(p)}
                        id={`btn-edit-product-${p.id}`}
                        style={{ padding: '0.35rem 0.65rem', fontSize: '0.75rem' }}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Product Create / Edit Modal */}
        {isModalOpen && (
          <div className="modal-backdrop" id="modal-product-backdrop">
            <div className="modal-card" style={{ maxWidth: '600px' }}>
              <h2>{editingProduct ? 'Edit Catalog Product' : 'Create New Product'}</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                {editingProduct
                  ? `Update details for SKU ${editingProduct.sku}`
                  : 'Define a new product for the catalog and search index.'}
              </p>

              <form onSubmit={handleSaveProduct} className="stack" style={{ gap: '0.9rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                  <label className="stack" style={{ gap: '0.3rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>SKU *</span>
                    <input
                      type="text"
                      required
                      placeholder="TSH-BLK-M"
                      value={formSku}
                      onChange={(e) => setFormSku(e.target.value)}
                      disabled={!!editingProduct}
                    />
                  </label>

                  <label className="stack" style={{ gap: '0.3rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>URL Slug</span>
                    <input
                      type="text"
                      placeholder="black-t-shirt-medium"
                      value={formSlug}
                      onChange={(e) => setFormSlug(e.target.value)}
                      disabled={!!editingProduct}
                    />
                  </label>
                </div>

                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Product Title *
                  </span>
                  <input
                    type="text"
                    required
                    placeholder="Premium Organic Cotton T-Shirt"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                  />
                </label>

                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Description
                  </span>
                  <textarea
                    rows={3}
                    placeholder="Product details, materials, and sizing…"
                    value={formDescription}
                    onChange={(e) => setFormDescription(e.target.value)}
                  />
                </label>

                <div
                  style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}
                >
                  <label className="stack" style={{ gap: '0.3rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Price (e.g. 24.99) *
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      required
                      min="0"
                      value={formPrice}
                      onChange={(e) => setFormPrice(e.target.value)}
                    />
                  </label>

                  <label className="stack" style={{ gap: '0.3rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Currency</span>
                    <input
                      type="text"
                      required
                      maxLength={3}
                      value={formCurrency}
                      onChange={(e) => setFormCurrency(e.target.value.toUpperCase())}
                    />
                  </label>

                  <label className="stack" style={{ gap: '0.3rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Weight (grams)
                    </span>
                    <input
                      type="number"
                      min="0"
                      value={formWeight}
                      onChange={(e) => setFormWeight(e.target.value)}
                    />
                  </label>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr',
                    gap: '0.75rem',
                    alignItems: 'center',
                  }}
                >
                  <label className="stack" style={{ gap: '0.3rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Category</span>
                    <select
                      value={formCategoryId}
                      onChange={(e) => setFormCategoryId(e.target.value)}
                    >
                      <option value="">No Category</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      cursor: 'pointer',
                      marginTop: '1.25rem',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={formActive}
                      onChange={(e) => setFormActive(e.target.checked)}
                    />
                    <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>Published Active</span>
                  </label>
                </div>

                <div
                  className="row"
                  style={{ justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}
                >
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setIsModalOpen(false)}
                    disabled={saving}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={saving}
                    id="btn-save-product-submit"
                  >
                    {saving ? 'Saving…' : editingProduct ? 'Update Product' : 'Create Product'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Category Edit Modal */}
        {isCategoryModalOpen && editingCategory && (
          <div className="modal-backdrop">
            <div className="modal-card">
              <h2>Edit Category</h2>
              <p className="subtitle" style={{ marginBottom: '1.25rem' }}>
                Slug{' '}
                <code style={{ color: 'var(--accent-secondary)' }}>{editingCategory.slug}</code> is
                immutable.
              </p>

              <form onSubmit={handleSaveCategory} className="stack" style={{ gap: '1rem' }}>
                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Category Name *
                  </span>
                  <input
                    type="text"
                    required
                    value={categoryName}
                    onChange={(e) => setCategoryName(e.target.value)}
                  />
                </label>

                <label className="stack" style={{ gap: '0.3rem' }}>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Description
                  </span>
                  <textarea
                    rows={3}
                    value={categoryDesc}
                    onChange={(e) => setCategoryDesc(e.target.value)}
                  />
                </label>

                <div className="row" style={{ justifyContent: 'flex-end', gap: '0.75rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setIsCategoryModalOpen(false)}
                    disabled={categorySaving}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={categorySaving}>
                    {categorySaving ? 'Saving…' : 'Save Changes'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AuthGate>
  );
}
