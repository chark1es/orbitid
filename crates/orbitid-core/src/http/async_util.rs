//! Array helpers for async predicates, ported from `lib/async.ts`.

pub async fn filter_async<T, F, Fut>(items: &[T], mut keep: F) -> Vec<T>
where
    T: Clone,
    F: FnMut(T) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let mut out = Vec::new();
    for item in items {
        if keep(item.clone()).await {
            out.push(item.clone());
        }
    }
    out
}

pub async fn find_async<T, F, Fut>(items: &[T], mut matches: F) -> Option<T>
where
    T: Clone,
    F: FnMut(T) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for item in items {
        if matches(item.clone()).await {
            return Some(item.clone());
        }
    }
    None
}

pub async fn some_async<T, F, Fut>(items: &[T], matches: F) -> bool
where
    T: Clone,
    F: FnMut(T) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    find_async(items, matches).await.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn predicates() {
        let items = [1, 2, 3, 4];
        let evens = filter_async(&items, |item| async move { item % 2 == 0 }).await;
        assert_eq!(evens, vec![2, 4]);
        assert_eq!(
            find_async(&items, |item| async move { item == 3 }).await,
            Some(3)
        );
        assert!(some_async(&items, |item| async move { item > 3 }).await);
        assert!(!some_async(&items, |item| async move { item > 4 }).await);
    }
}
