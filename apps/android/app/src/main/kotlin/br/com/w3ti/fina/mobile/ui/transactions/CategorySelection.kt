package br.com.w3ti.fina.mobile.ui.transactions

import br.com.w3ti.fina.mobile.data.CategoryEntity

/** Resolve o único categoryId do lançamento nos dois campos do formulário. */
internal class CategorySelection(categories: List<CategoryEntity>, selectedId: String?) {
    val roots = categories.filter { it.parentId == null }
    private val selected = categories.firstOrNull { it.id == selectedId }
    val category = roots.firstOrNull { it.id == (selected?.parentId ?: selected?.id) }
    val subcategories = categories.filter { category != null && it.parentId == category.id }
    val subcategory = subcategories.firstOrNull { it.id == selectedId }
    val transactionCategoryId = subcategory?.id ?: category?.id

    fun selectCategory(categoryId: String?): String? =
        if (categoryId == category?.id) transactionCategoryId else categoryId
}
