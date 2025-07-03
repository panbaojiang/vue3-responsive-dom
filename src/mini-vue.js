// === mini-vue.js ===
// 简化版Vue3响应式系统实现

// 全局依赖存储：使用WeakMap存储所有响应式对象的依赖关系
// 结构：targetMap = WeakMap<target, Map<key, Set<effectFn>>>
const targetMap = new WeakMap();

// 当前激活的副作用函数：用于在track时知道当前正在执行的effect
let activeEffect = null;

// 副作用函数栈：用于处理嵌套effect的情况（如effect中调用effect）
const effectStack = [];

/**
 * 创建响应式副作用函数
 * @param {Function} fn 要执行的副作用函数（如渲染函数、计算属性）
 * @param {Object} options 配置选项（如lazy、scheduler）
 * @returns {Function} 返回副作用函数本身（可用于手动执行）
 */
function effect (fn, options = {}) {
  // 创建effect函数，添加执行逻辑和依赖管理
  const effectFn = () => {
    // 1. 清理旧依赖：避免已不再使用的依赖导致内存泄漏
    cleanup(effectFn);

    // 2. 设置当前激活的effect
    activeEffect = effectFn;
    // 3. 将effect压入栈中（处理嵌套）
    effectStack.push(effectFn);

    // 4. 执行用户函数（期间会触发track收集依赖）
    const result = fn();

    // 5. 执行完毕弹出栈
    effectStack.pop();
    // 6. 恢复activeEffect为上一个effect
    activeEffect = effectStack[effectStack.length - 1];

    return result;
  };

  // 为effect函数添加依赖存储和配置选项
  effectFn.deps = []; // 存储所有包含该effect的依赖集合
  effectFn.options = options; // 存储配置选项

  // 如果不是懒执行，立即运行一次
  if (!options.lazy) {
    effectFn();
  }

  return effectFn;
}

/**
 * 清理effect的依赖集合
 * @param {Function} effectFn 需要清理的副作用函数
 */
function cleanup (effectFn) {
  // 遍历所有依赖集合，从中移除当前effect
  for (let i = 0; i < effectFn.deps.length; i++) {
    const dep = effectFn.deps[i];
    dep.delete(effectFn);
  }
  // 重置依赖数组
  effectFn.deps.length = 0;
}

/**
 * 依赖收集：在属性被访问时调用
 * @param {Object} target 目标对象
 * @param {string|symbol} key 访问的属性键
 */
function track (target, key) {
  // 如果没有激活的effect，直接返回（非响应式访问）
  if (!activeEffect) return;

  // 1. 获取目标的依赖Map（不存在则创建）
  let depsMap = targetMap.get(target);
  if (!depsMap) {
    depsMap = new Map();
    targetMap.set(target, depsMap);
  }

  // 2. 获取属性的依赖Set（不存在则创建）
  let dep = depsMap.get(key);
  if (!dep) {
    dep = new Set();
    depsMap.set(key, dep);
  }

  // 3. 将当前激活的effect添加到依赖集合中
  dep.add(activeEffect);

  // 4. 在effect中也记录这个依赖（便于清理）
  activeEffect.deps.push(dep);
}

/**
 * 触发更新：在属性被修改时调用
 * @param {Object} target 目标对象
 * @param {string|symbol} key 修改的属性键
 */
function trigger (target, key) {
  // 1. 获取目标的依赖Map
  const depsMap = targetMap.get(target);
  if (!depsMap) return;

  // 2. 获取属性的依赖Set
  const dep = depsMap.get(key);
  if (dep) {
    // 3. 创建effects副本，避免forEach中删除导致的问题
    const effects = new Set(dep);

    // 4. 执行所有依赖的effect
    effects.forEach(effectFn => {
      // 如果有调度器，使用调度器执行
      if (effectFn.options.scheduler) {
        effectFn.options.scheduler(effectFn);
      } else {
        // 否则直接执行（使用队列避免重复执行）
        queueJob(effectFn);
      }
    });
  }
}

/**
 * 创建响应式对象
 * @param {Object} target 原始对象
 * @returns {Proxy} 代理后的响应式对象
 */
function reactive (target) {
  return new Proxy(target, {
    // 拦截属性读取
    get (target, key, receiver) {
      // 1. 获取原始值
      const result = Reflect.get(target, key, receiver);

      // 2. 收集依赖
      track(target, key);

      // 3. 如果值是对象，递归创建响应式对象（深度响应）
      return typeof result === 'object' && result !== null
        ? reactive(result)
        : result;
    },

    // 拦截属性设置
    set (target, key, value, receiver) {
      // 1. 获取旧值
      const oldValue = target[key];
      // 2. 设置新值
      const result = Reflect.set(target, key, value, receiver);

      // 3. 只有值变化时才触发更新（避免不必要的更新）
      if (oldValue !== value) {
        trigger(target, key);
      }

      return result;
    }
  });
}

/**
 * 创建计算属性
 * @param {Function} getter 计算函数
 * @returns {Object} 包含value属性的计算属性对象
 */
function computed (getter) {
  let value; // 缓存值
  let dirty = true; // 标记是否需要重新计算

  // 创建懒执行的effect（只有读取时才计算）
  const effectFn = effect(getter, {
    lazy: true,
    scheduler () {
      // 当依赖变化时，标记为dirty（但不立即计算）
      dirty = true;
      // 通知计算属性的使用者（如模板）需要更新
      trigger(computedRef, 'value');
    }
  });

  // 创建计算属性引用对象
  const computedRef = {
    get value () {
      // 1. 如果是dirty，重新计算
      if (dirty) {
        value = effectFn();
        dirty = false;
      }
      // 2. 收集计算属性自身的依赖（如模板中使用计算属性）
      track(computedRef, 'value');
      // 3. 返回缓存值
      return value;
    }
  };

  return computedRef;
}

// === 调度器相关 ===

// 微任务队列：存储待执行的effect
const queue = new Set();
// 标记是否正在刷新队列
let isFlushing = false;

/**
 * 将job加入微任务队列（避免重复添加）
 * @param {Function} job 要执行的副作用函数
 */
function queueJob (job) {
  queue.add(job);

  // 如果还没有安排刷新，创建一个微任务来执行队列
  if (!isFlushing) {
    isFlushing = true;
    // 使用Promise.resolve()创建微任务
    Promise.resolve().then(() => {
      // 执行所有队列中的job
      queue.forEach(j => j());
      // 清空队列
      queue.clear();
      // 重置标记
      isFlushing = false;
    });
  }
}

// 修改trigger函数，集成调度器逻辑
const originalTrigger = trigger;
function trigger (target, key) {
  const depsMap = targetMap.get(target);
  if (!depsMap) return;

  const dep = depsMap.get(key);
  if (dep) {
    const effects = new Set(dep);
    effects.forEach(effectFn => {
      // 优先使用自定义调度器，否则使用默认队列
      if (effectFn.options.scheduler) {
        effectFn.options.scheduler(effectFn);
      } else {
        queueJob(effectFn);
      }
    });
  }
}