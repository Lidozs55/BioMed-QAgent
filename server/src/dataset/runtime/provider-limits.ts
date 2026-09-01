/**
 * Provider 载体内存闸门（代码级常量，不走 settings）。
 *
 * Provider 载体在解析前会被整体载入内存（Buffer → UTF-16 字符串 → 解析对象树），
 * fast-xml-parser 等对象树解析的内存膨胀可达源文件的 10 倍以上：一个数百 MB 的
 * XML 载体（如 Orphadata ``en_product1.xml``）足以把 Node 堆撑到 OOM 崩溃
 * （2026-08-29 gold9 r1 Host 进程崩溃事故）。以下闸门把这类失败从进程死亡
 * 转化为带修复指引的干净报错；需要处理更大的载体时，必须改用流式/分片解析
 * 实现，而不是放宽这些值。
 */

/** Provider 载体（任意格式）允许载入内存的最大字节数。 */
export const MAX_PROVIDER_CARRIER_BYTES = 128 * 1024 * 1024;

/**
 * XML 载体允许进入对象树解析的最大字节数（对象树膨胀约 10 倍，阈值需保守）。
 *
 * 2026-09-01：gold9 卡点复现显示 Orphadata ``en_product1.xml`` 实测约 53.9MB
 * （2026-06-29 快照，ETag 0x338622f），此前 32MB 阈值把官方全量快照挡在解析外；
 * 适当上调至 64MB（仍是旧 OOM 事故“数百 MB 级 XML”的 ~1/8，对象树约 500MB，堆内安全）。
 * 超过 64MB 的更大载体仍须走流式/分片解析，不得继续放宽。
 */
export const MAX_XML_CARRIER_BYTES = 64 * 1024 * 1024;
