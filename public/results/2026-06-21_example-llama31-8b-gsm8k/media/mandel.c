/* Tiny WebAssembly demo module — compiles to a ~1 KB .wasm with:
 *   clang --target=wasm32 -nostdlib -O2 -Wl,--no-entry \
 *     -Wl,--export=framebuffer -Wl,--export=render -Wl,--export-memory \
 *     -o mandel.wasm mandel.c
 * The site ships a compatible generic loader (public/wasm-loader.js).
 */
#define MAXW 800
#define MAXH 600

static unsigned char fb[MAXW * MAXH * 4];

__attribute__((export_name("framebuffer")))
unsigned char *framebuffer(void) { return fb; }

__attribute__((export_name("render")))
int render(int w, int h, double cx, double cy, double scale, int max_iter) {
  if (w < 1 || h < 1) return 0;
  if (w > MAXW) w = MAXW;
  if (h > MAXH) h = MAXH;
  if (max_iter < 8) max_iter = 8;
  if (scale <= 0) scale = 4.0 / w;

  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      double px = cx + (x - w / 2.0) * scale;
      double py = cy + (y - h / 2.0) * scale;
      double zr = 0.0, zi = 0.0;
      int i = 0;
      while (i < max_iter && zr * zr + zi * zi <= 4.0) {
        double t = zr * zr - zi * zi + px;
        zi = 2.0 * zr * zi + py;
        zr = t;
        i++;
      }
      unsigned char *p = &fb[(y * w + x) * 4];
      if (i >= max_iter) {
        p[0] = 8; p[1] = 10; p[2] = 16; p[3] = 255;
      } else {
        double m = (double)i / (double)max_iter;
        double s = m * m * m;
        p[0] = (unsigned char)(18 + 220 * s);
        p[1] = (unsigned char)(26 + 150 * m);
        p[2] = (unsigned char)(70 + 175 * (1.0 - m));
        p[3] = 255;
      }
    }
  }
  return 1;
}
