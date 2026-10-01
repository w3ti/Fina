package br.com.w3ti.fina.mobile.ui.transactions

import br.com.w3ti.fina.mobile.data.CategoryEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CategorySelectionTest {
    private val food = CategoryEntity("food", "Alimentação", null, "variable")
    private val transport = CategoryEntity("transport", "Transporte", null, "variable")
    private val market = CategoryEntity("market", "Mercado", food.id, "variable")
    private val fuel = CategoryEntity("fuel", "Combustível", transport.id, "variable")
    private val categories = listOf(food, fuel, market, transport)

    @Test fun newTransactionOffersOnlyRootsUntilCategoryIsSelected() {
        val selection = CategorySelection(categories, null)
        assertEquals(listOf(food, transport), selection.roots)
        assertTrue(selection.subcategories.isEmpty())
        assertNull(selection.transactionCategoryId)
    }

    @Test fun rootSelectionAllowsSavingWithoutSubcategory() {
        val selection = CategorySelection(categories, food.id)
        assertEquals(food, selection.category)
        assertEquals(listOf(market), selection.subcategories)
        assertNull(selection.subcategory)
        assertEquals(food.id, selection.transactionCategoryId)
    }

    @Test fun editingSubcategoryRestoresBothFieldsAndKeepsItsIdForSync() {
        val selection = CategorySelection(categories, market.id)
        assertEquals(food, selection.category)
        assertEquals(market, selection.subcategory)
        assertEquals(market.id, selection.transactionCategoryId)
    }

    @Test fun changingParentClearsThePreviousSubcategory() {
        val previous = CategorySelection(categories, market.id)
        val selection = CategorySelection(categories, previous.selectCategory(transport.id))
        assertEquals(transport, selection.category)
        assertEquals(listOf(fuel), selection.subcategories)
        assertNull(selection.subcategory)
        assertEquals(transport.id, selection.transactionCategoryId)
        assertEquals(market.id, previous.selectCategory(food.id))
    }

    @Test fun rootWithoutChildrenCanBeSaved() {
        val selection = CategorySelection(listOf(food), food.id)
        assertTrue(selection.subcategories.isEmpty())
        assertEquals(food.id, selection.transactionCategoryId)
    }

    @Test fun removingSubcategoryKeepsTheParentForSync() {
        val previous = CategorySelection(categories, market.id)
        val selection = CategorySelection(categories, previous.category?.id)
        assertNull(selection.subcategory)
        assertEquals(food.id, selection.transactionCategoryId)
    }

    @Test fun editingSelectionResolvesAfterCategoriesLoad() {
        assertNull(CategorySelection(emptyList(), market.id).transactionCategoryId)
        val selection = CategorySelection(categories, market.id)
        assertEquals(food, selection.category)
        assertEquals(market, selection.subcategory)
    }

    @Test fun missingCategoryOrParentCannotBeSubmitted() {
        assertNull(CategorySelection(categories, "deleted").transactionCategoryId)
        assertNull(CategorySelection(listOf(market), market.id).transactionCategoryId)
    }
}
