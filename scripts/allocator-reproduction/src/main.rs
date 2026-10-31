//! Reproduce LuaJIT's address constraint after cross-thread system allocation reuse.
//! 复现跨线程复用系统分配内存后违反 LuaJIT 地址约束的问题。

/// Contaminate the caller's small-allocation cache with worker allocations; then compile Lua.
/// 使用工作线程分配填充调用线程的小对象缓存，随后编译 Lua。
/// No arguments are accepted; success means every repeated compilation completed without a crash.
/// 不接收参数；成功表示所有重复编译均完成且未崩溃。
fn main() {
    // Non-PIE linking matches Node's low main heap and exposes mixed low/high allocation addresses.
    // 非 PIE 链接匹配 Node 的低位主堆，暴露高低分配地址混合的情况。
    let lua = mlua::Lua::new();
    for round in 0..16 {
        // Worker arenas supply allocations that can later enter the main thread's free cache.
        // 工作线程的内存区提供稍后可进入主线程空闲缓存的分配。
        let allocations = std::thread::spawn(|| {
            // Cover the parser's string and prototype allocation size classes without using LuaSkills.
            // 覆盖解析器字符串与原型的分配大小类别，完全不使用 LuaSkills。
            let mut allocations = Vec::new();
            for size in (16..=1024).step_by(16) {
                for _ in 0..16 {
                    allocations.push(vec![0x5au8; size].into_boxed_slice());
                }
            }
            allocations
        }).join().expect("allocation worker failed");
        eprintln!("round={round} worker_allocation={:p}", allocations[0].as_ptr());
        drop(allocations);
        lua.load("local t = {}; for i=1,256 do t[i] = 'address-test-' .. i end; return #t")
            .exec().expect("Lua compilation failed");
        eprintln!("round={round} compiled");
    }
}
