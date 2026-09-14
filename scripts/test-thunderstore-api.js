// ============================================================
// test-thunderstore-api.js
//
// 用途:独立的连通性 + 数据探测脚本,不属于 Azure Functions 项目。
// 目的是确认"这台机器能不能正常访问 Thunderstore 的 v1 社区接口",
// 并且验证我们打算写进数据库的几个核心数值能不能从返回数据里算出来。
//
// 运行方式:
//   node scripts/test-thunderstore-api.js
//
// 做的事情:
//   1. 向 Thunderstore sulfur 社区的 v1 全量包列表接口发一个 GET 请求
//      (这个接口一次返回该社区所有 mod,不需要认证)
//   2. 请求头里带上一个普通浏览器的 User-Agent
//   3. 从返回列表中筛选出 owner 为 ryuka_labs 的所有条目
//   4. 对每一条,把 versions[].downloads 逐个相加,算出总下载量
//      (接口本身没有"总下载量"字段,只有每个版本各自的下载量)
//   5. 把 mod 名称、总下载量、评分、版本数 用表格打印出来
//
// 输入:无(URL 和 owner 写死在下面的常量里)
// 输出:HTTP 状态码、社区包总数、筛选后的表格
// ============================================================

// sulfur 社区的 v1 全量包列表接口
const API_URL = "https://thunderstore.io/c/sulfur/api/v1/package/";

// 只关心这个作者名下的 mod
const TARGET_OWNER = "ryuka_labs";

// 模拟一个普通 Chrome 浏览器的 User-Agent(有些站点会拒绝没有 UA 的请求)
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// 计算一个包的总下载量:把它所有版本的 downloads 加起来
// 输入:接口返回的单个包对象(里面有 versions 数组)
// 输出:整数,所有版本下载量之和
function sumDownloads(pkg) {
  let total = 0;
  for (const version of pkg.versions) {
    total += version.downloads;
  }
  return total;
}

// 主函数:发请求、筛选、计算、打印
async function main() {
  console.log("请求地址:", API_URL);
  console.log("筛选 owner:", TARGET_OWNER);
  console.log("");

  // Node.js 18 以后自带 fetch,不需要额外安装 axios 之类的库
  const response = await fetch(API_URL, {
    method: "GET",
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      "Accept": "application/json",
    },
  });

  console.log("HTTP 状态码:", response.status, response.statusText);

  // 状态码不是 2xx 的话,先把原始响应体打印出来再退出,方便排查
  if (!response.ok) {
    const text = await response.text();
    console.error("请求失败,原始响应体如下:");
    console.error(text);
    process.exit(1);
  }

  // 返回的是一个数组,每个元素是一个包
  const allPackages = await response.json();
  console.log("社区里的包总数:", allPackages.length);

  // 只保留 owner 为 ryuka_labs 的
  const myPackages = allPackages.filter((pkg) => pkg.owner === TARGET_OWNER);
  console.log(`其中 owner 为 ${TARGET_OWNER} 的包:`, myPackages.length);
  console.log("");

  // 整理成表格需要的形状,并按总下载量从高到低排序
  const rows = myPackages.map((pkg) => ({
    "mod 名称": pkg.name,
    "总下载量": sumDownloads(pkg),
    "评分": pkg.rating_score,
    "版本数": pkg.versions.length,
    "最新版本": pkg.versions[0].version_number,
  }));
  rows.sort((a, b) => b["总下载量"] - a["总下载量"]);

  // console.table 会自动画出一个对齐的表格
  console.table(rows);

  // 再打印一个全部 mod 的合计,方便对总量有个概念
  const grandTotal = rows.reduce((sum, r) => sum + r["总下载量"], 0);
  console.log("所有 mod 总下载量合计:", grandTotal);
}

// 捕获任何未处理的错误(比如 DNS 解析失败、网络不通),打印后以非 0 退出码结束
main().catch((err) => {
  console.error("脚本执行出错:", err);
  process.exit(1);
});
