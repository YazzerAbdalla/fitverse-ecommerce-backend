export interface AddCartItemProps {
  userId: string;
  productId: string;
  quantity: number;
}

export interface RemoveCartItemProps {
  userId: string;
  productId: string;
}
