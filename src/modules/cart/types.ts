export interface AddCartItemProps {
  userId: string;
  productId: string;
  quantity: number;
}

export interface RemoveCartItemProps {
  userId: string;
  cartItemId: string;
}

export interface UpdateCartItemQuantityProps {
  userId: string;
  productId: string;
  quantity?: number;
}
