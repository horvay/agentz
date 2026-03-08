# Avoiding useEffect: Best Practices in React

## Introduction

`useEffect` is a powerful React hook for synchronizing components with external systems, but it's often overused. Many scenarios that seem to require `useEffect` can be handled more efficiently and simply by calculating values during render, using other hooks, or restructuring your components. This guide explains when and how to avoid `useEffect` based on React's official documentation.

## When to Avoid useEffect

You don't need `useEffect` for:
- Transforming data for rendering
- Handling user events
- Caching expensive computations (use `useMemo` instead)
- Resetting state on prop changes (use keys or calculate during render)

## Key Alternatives

### 1. Calculate During Render Instead of State

**Problem:** Using `useEffect` to derive state from props or other state.

```javascript
// ❌ Avoid: Redundant state and Effect
function Form() {
  const [firstName, setFirstName] = useState('Taylor');
  const [lastName, setLastName] = useState('Swift');
  const [fullName, setFullName] = useState('');
  
  useEffect(() => {
    setFullName(firstName + ' ' + lastName);
  }, [firstName, lastName]);
  
  return <div>{fullName}</div>;
}
```

**Solution:** Calculate during render.

```javascript
// ✅ Good: Calculate during rendering
function Form() {
  const [firstName, setFirstName] = useState('Taylor');
  const [lastName, setLastName] = useState('Swift');
  const fullName = firstName + ' ' + lastName; // No state needed
  
  return <div>{fullName}</div>;
}
```

### 2. Cache Expensive Calculations with useMemo

**Problem:** Filtering or transforming large datasets in `useEffect`.

```javascript
// ❌ Avoid: Unnecessary Effect for filtering
function TodoList({ todos, filter }) {
  const [visibleTodos, setVisibleTodos] = useState([]);
  
  useEffect(() => {
    setVisibleTodos(getFilteredTodos(todos, filter));
  }, [todos, filter]);
  
  return <ul>{visibleTodos.map(todo => <li key={todo.id}>{todo.text}</li>)}</ul>;
}
```

**Solution:** Use `useMemo` for caching.

```javascript
// ✅ Good: Cache with useMemo
function TodoList({ todos, filter }) {
  const visibleTodos = useMemo(() => {
    return getFilteredTodos(todos, filter);
  }, [todos, filter]);
  
  return <ul>{visibleTodos.map(todo => <li key={todo.id}>{todo.text}</li>)}</ul>;
}
```

### 3. Reset State with Keys

**Problem:** Resetting component state when props change.

```javascript
// ❌ Avoid: Resetting state in Effect
function ProfilePage({ userId }) {
  const [comment, setComment] = useState('');
  
  useEffect(() => {
    setComment('');
  }, [userId]);
  
  return <Profile userId={userId} comment={comment} setComment={setComment} />;
}
```

**Solution:** Use keys to reset entire component trees.

```javascript
// ✅ Good: Reset with key
function ProfilePage({ userId }) {
  return (
    <Profile
      userId={userId}
      key={userId} // Resets state when userId changes
    />
  );
}

function Profile({ userId }) {
  const [comment, setComment] = useState(''); // Automatically resets
  return <input value={comment} onChange={e => setComment(e.target.value)} />;
}
```

### 4. Adjust State During Render

**Problem:** Adjusting state based on prop changes.

```javascript
// ❌ Avoid: Adjusting state in Effect
function List({ items }) {
  const [selection, setSelection] = useState(null);
  
  useEffect(() => {
    setSelection(null);
  }, [items]);
  
  return <div>{/* render items */}</div>;
}
```

**Solution:** Adjust during render.

```javascript
// ✅ Good: Adjust during rendering
function List({ items }) {
  const [selection, setSelection] = useState(null);
  const [prevItems, setPrevItems] = useState(items);
  
  if (items !== prevItems) {
    setPrevItems(items);
    setSelection(null);
  }
  
  return <div>{/* render items */}</div>;
}
```

### 5. Move Logic to Event Handlers

**Problem:** Event-specific logic in `useEffect`.

```javascript
// ❌ Avoid: Event logic in Effect
function ProductPage({ product, addToCart }) {
  useEffect(() => {
    if (product.isInCart) {
      showNotification(`Added ${product.name} to the shopping cart!`);
    }
  }, [product]);
  
  return <button onClick={() => addToCart(product)}>Buy</button>;
}
```

**Solution:** Put event logic in event handlers.

```javascript
// ✅ Good: Event logic in handlers
function ProductPage({ product, addToCart }) {
  function handleBuyClick() {
    addToCart(product);
    showNotification(`Added ${product.name} to the shopping cart!`);
  }
  
  return <button onClick={handleBuyClick}>Buy</button>;
}
```

### 6. Use Built-in Hooks for External Data

**Problem:** Manual subscription to external stores.

```javascript
// ❌ Avoid: Manual subscription in Effect
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(true);
  
  useEffect(() => {
    function updateState() {
      setIsOnline(navigator.onLine);
    }
    updateState();
    window.addEventListener('online', updateState);
    window.addEventListener('offline', updateState);
    return () => {
      window.removeEventListener('online', updateState);
      window.removeEventListener('offline', updateState);
    };
  }, []);
  
  return isOnline;
}
```

**Solution:** Use `useSyncExternalStore`.

```javascript
// ✅ Good: Use useSyncExternalStore
function subscribe(callback) {
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

function useOnlineStatus() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine, // Client value
    () => true // Server value
  );
}
```

## Benefits of Avoiding useEffect

- **Performance:** Eliminates unnecessary re-renders and cascading updates
- **Simplicity:** Reduces code complexity and potential bugs
- **Predictability:** Makes data flow easier to understand and debug
- **Maintainability:** Less error-prone code with fewer side effects

## When useEffect IS Appropriate

- Synchronizing with external systems (APIs, DOM, third-party libraries)
- Analytics and logging
- Setting up subscriptions (though prefer `useSyncExternalStore`)
- Data fetching (with proper cleanup to avoid race conditions)

Remember: If you can calculate something during render, you don't need an Effect. Always ask: "Why does this code need to run?" If it's because the component was displayed, use Effect. If it's due to user interaction, use event handlers.