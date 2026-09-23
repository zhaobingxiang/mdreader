"""生成 mdreader 应用图标（多尺寸 ICO）。

不依赖 Pillow —— 手工光栅化后按经典 BMP 条目封装。
注意：Inno Setup 不接受 PNG 压缩的 ICO 条目（EndUpdateResource 会失败），
所以这里一律用 32bpp BMP + AND 掩码。

用法：python tools/make-icon.py
"""
import os
import struct
import sys
import zlib

BASE = 256          # 设计基准尺寸
SS = 6              # 超采样倍数，用于抗锯齿
N = BASE * SS       # 1536，可被下面所有尺寸整除
DEFAULT_SIZES = [16, 32, 48, 64, 128, 256]

BG = (9, 105, 218, 255)
PAPER = (255, 255, 255, 255)
INK = (9, 105, 218, 255)
BLANK = (0, 0, 0, 0)

canvas = [[BLANK for _ in range(N)] for _ in range(N)]


def rrect(x0, y0, x1, y1, radius, color):
    """圆角矩形，坐标基于 BASE 尺度"""
    ax0, ay0, ax1, ay1 = x0 * SS, y0 * SS, x1 * SS, y1 * SS
    r = radius * SS
    for y in range(int(ay0), int(ay1)):
        dy = 0.0
        if y < ay0 + r:
            dy = ay0 + r - y
        elif y > ay1 - r - 1:
            dy = y - (ay1 - r - 1)
        for x in range(int(ax0), int(ax1)):
            dx = 0.0
            if x < ax0 + r:
                dx = ax0 + r - x
            elif x > ax1 - r - 1:
                dx = x - (ax1 - r - 1)
            if dx * dx + dy * dy <= r * r:
                canvas[y][x] = color


def rect(x0, y0, x1, y1, color):
    rrect(x0, y0, x1, y1, 0, color)


# 1. 蓝色圆角底板
rrect(14, 14, 242, 242, 54, BG)

# 2. 白色纸张
rrect(70, 44, 186, 212, 12, PAPER)

# 3. 右上角折角：把纸张右上角三角还原成底色
fold_x, fold_y = 138, 92
for y in range(44 * SS, fold_y * SS):
    for x in range(fold_x * SS, 187 * SS):
        if (x - fold_x * SS) + (fold_y * SS - y) > (fold_y - 44) * SS:
            canvas[y][x] = BG

# 4. 正文横线，末行短一些
for index, y in enumerate([100, 126, 152, 178]):
    width = 42 if index == 3 else 76
    rect(88, y, 88 + width, y + 10, INK)


def downsample(target):
    """把超采样画布平均降采样到 target 尺寸"""
    step = N // target
    rows = []
    for ty in range(target):
        row = []
        for tx in range(target):
            r = g = b = a = 0
            for dy in range(step):
                line = canvas[ty * step + dy]
                for dx in range(step):
                    p = line[tx * step + dx]
                    r += p[0]
                    g += p[1]
                    b += p[2]
                    a += p[3]
            total = step * step
            row.append((r // total, g // total, b // total, a // total))
        rows.append(row)
    return rows


def bmp_entry(rows, size):
    """32bpp BMP 条目：BITMAPINFOHEADER + BGRA 像素 + AND 掩码，均为自底向上"""
    mask_stride = ((size + 31) // 32) * 4
    xor_len = size * size * 4
    mask_len = mask_stride * size

    header = struct.pack(
        '<IiiHHIIiiII',
        40,                  # biSize
        size,                # biWidth
        size * 2,            # biHeight（高度翻倍，因为后面跟 AND 掩码）
        1,                   # biPlanes
        32,                  # biBitCount
        0,                   # biCompression
        xor_len + mask_len,  # biSizeImage（必须非 0，且长度含 AND 掩码）
        0, 0, 0, 0,
    )

    xor = bytearray()
    for y in range(size - 1, -1, -1):
        row = rows[y]
        for x in range(size):
            r, g, b, a = row[x]
            xor += bytes((b, g, r, a))

    and_mask = bytearray()
    for y in range(size - 1, -1, -1):
        row = rows[y]
        bits = bytearray(mask_stride)
        for x in range(size):
            if row[x][3] < 128:
                bits[x // 8] |= 0x80 >> (x % 8)
        and_mask += bits

    return bytes(header) + bytes(xor) + bytes(and_mask)


def encode_png(rows, width, height):
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        payload = tag + data
        return (
            struct.pack('>I', len(data))
            + payload
            + struct.pack('>I', zlib.crc32(payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
        + chunk(b'IEND', b'')
    )


# 可选参数：尺寸列表、输出路径
#   python tools/make-icon.py "16,32,48" assets/out.ico
sizes = DEFAULT_SIZES
if len(sys.argv) > 1 and sys.argv[1].strip():
    sizes = [int(part) for part in sys.argv[1].split(',') if part.strip()]
out_override = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2].strip() else None

entries = []
preview_png = None
for size in sizes:
    rows = downsample(size)
    entries.append((size, bmp_entry(rows, size)))
    if size == 256:
        preview_png = encode_png(rows, size, size)

# ICO 容器
offset = 6 + 16 * len(entries)
directory = struct.pack('<HHH', 0, 1, len(entries))
body = b''
for size, data in entries:
    dim = 0 if size >= 256 else size   # 256 写 0
    directory += struct.pack(
        '<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset
    )
    body += data
    offset += len(data)

ico = directory + body

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
target = out_override or os.path.join(root, 'assets', 'mdreader.ico')
os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)
with open(target, 'wb') as fp:
    fp.write(ico)

preview = os.path.join(os.path.dirname(os.path.abspath(target)), 'mdreader-preview.png')
with open(preview, 'wb') as fp:
    fp.write(preview_png)

print(f'图标已生成：{target}')
print(f'  尺寸: {sizes}')
print(f'  大小: {len(ico)} 字节')
print(f'预览图：{preview}')
