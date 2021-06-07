import numpy as np
import math
import random
import cmath
from PIL import Image
from tqdm import tqdm
from matplotlib import cm

# Maps a point on the complex plane to an integer 
# (x, y) coordinate within an image w/ a width and height
def complex_to_image(z, width, height, real_range, imag_range, centered_at):
    bottom_left = centered_at - complex(real_range / 2, imag_range / 2)
    # Find x coordinate
    x = (z.real - bottom_left.real) / real_range # Normalized
    x *= width

    # Find y coordinate
    y = (z.imag - bottom_left.imag) / imag_range # Normalized
    y = 1 - y
    y *= height

    return (int(x), int(y))

# Maps a point on the image to a point on the complex plane
def image_to_complex(x, y, width, height, real_range, imag_range):
    # Normalize coordinates and flip y direction
    u = x / width
    v = y / height
    v = 1 - v

    u *= real_range
    v *= imag_range
    u -= real_range / 2
    v -= real_range / 2

    return complex(u, v)

# Takes in an array of counts representing the density of points in the image,
# and returns a colored image mapping density to color
def color_image(counts, width, height, cmap):
    im_arr = np.full((height, width, 3), 255, dtype=np.uint8)

    max_count = np.max(counts)

    print("Coloring final image...")
    for y in tqdm(range(height)):
        for x in range(width):
            if counts[y, x] != 0:
                brightness = math.log(counts[y, x]) / math.log(max_count)
                gamma = 2.2
                brightness = math.pow(brightness, 1/gamma)
                rgba = cmap(brightness)
                im_arr[y, x, 0] = int(255 * rgba[0])
                im_arr[y, x, 1] = int(255 * rgba[1])
                im_arr[y, x, 2] = int(255 * rgba[2])

    im = Image.fromarray(im_arr)
    return im

# Linear affine transformation w/ scaling, rotation, and translation
def transformation(z_prev, a_j, q_j, t_j):
    return t_j + a_j * cmath.exp(complex(0, 1) * 2 * math.pi * q_j) * z_prev

def sierpinski(width, height, real_range, imag_range, centered_at, samples, cmap):
    mono_coloring = False
    counts = np.zeros((height, width), dtype=np.uint64)

    # Start w/ random point in biunit square
    z = complex(random.random() * 2 - 1, random.random() * 2 - 1)
    for n in tqdm(range(samples)):
        choice = random.random()
        if choice > 0.5:
            # f_1
            a = 1.0
            q = 1 / 3
            t = complex(0, 0)
        else: 
            # f_2
            a = 0.5
            q = 1
            t = complex(0, 1)
        
        z = transformation(z, a, q, t)

        if n > 20:
            x, y = complex_to_image(z, width, height, real_range, imag_range, centered_at)
            if (0 <= x < width) and (0 <= y < height):
                counts[y, x] += 1
            
    return color_image(counts, width, height, cmap)

def triangle(width, height, real_range, imag_range, centered_at, samples, cmap):
    mono_coloring = False
    counts = np.zeros((height, width), dtype=np.uint64)

    # Start w/ random point in biunit square
    z = complex(random.random() * 2 - 1, random.random() * 2 - 1)
    for n in tqdm(range(samples)):
        choice = random.random()
        if choice > 0.5:
            # f_1
            a = 1.0
            q = 1.0 / 3.0
            t = complex(0, 0)
        else: 
            # f_2
            a = 2.0 / 3.0
            q = -1.0 / 3.0
            t = complex(0, 1.0)
        
        z = transformation(z, a, q, t)

        if n > 20:
            x, y = complex_to_image(z, width, height, real_range, imag_range, centered_at)
            if (0 <= x < width) and (0 <= y < height):
                counts[y, x] += 1
            
    return color_image(counts, width, height, cmap)

def pentagon(width, height, real_range, imag_range, centered_at, samples, cmap):
    mono_coloring = False
    counts = np.zeros((height, width), dtype=np.uint64)

    # Start w/ random point in biunit square
    z = complex(random.random() * 2 - 1, random.random() * 2 - 1)
    for n in tqdm(range(samples)):
        choice = random.random()
        if choice > 0.5:
            # f_1
            a = 1.0
            q = 1 / 5
            t = complex(0, 0)
        else: 
            # f_2
            a = 0.5
            q = 3 / 5
            t = complex(0, 1)
        
        z = transformation(z, a, q, t)

        if n > 20:
            x, y = complex_to_image(z, width, height, real_range, imag_range, centered_at)
            if (0 <= x < width) and (0 <= y < height):
                counts[y, x] += 1

            
    return color_image(counts, width, height, cmap)

def exploding_hexagon(width, height, real_range, imag_range, centered_at, samples, cmap):
    mono_coloring = False
    counts = np.zeros((height, width), dtype=np.uint64)

    # Start w/ random point in biunit square
    z = complex(random.random() * 2 - 1, random.random() * 2 - 1)
    for n in tqdm(range(samples)):
        choice = random.choice([1, 2, 3])
        if choice == 1:
            # f_1
            a = 1.0
            q = 1.0 / 6.0
            t = complex(0, 0)
        elif choice == 2:
            # f_2
            a = 0.5
            q = 1.0 / 6.0
            t = complex(0, 1)
        else: 
            #f_3
            a = 0.5
            q = 1.0
            t = complex(-5.1962, 3)
        
        z = transformation(z, a, q, t)

        if n > 20:
            x, y = complex_to_image(z, width, height, real_range, imag_range, centered_at)
            if (0 <= x < width) and (0 <= y < height):
                counts[y, x] += 1

            
    return color_image(counts, width, height, cmap)

def dragon(width, height, real_range, imag_range, centered_at, samples, cmap):
    mono_coloring = True
    im_arr = np.zeros((height, width, 3), dtype=np.uint8)
    counts = np.zeros((width, height), dtype=np.uint64)

    z = complex(.372, -0.547)
    x = complex(0, 0)
    for n in tqdm(range(samples)):
        choice = random.random()
        if choice > 0.5:
            x = 1 + z * x
        else: 
            x = 1 - z * x
        if n > 5:
            i, j = complex_to_image(x, width, height, real_range, imag_range, centered_at)
            if (0 <= i < width) and (0 <= j < height):
                counts[j, i] += 1
    
    return color_image(counts, width, height, cmap)

if __name__ == "__main__":
    # Define window of complex plane to look at
    centered_at = complex(0, 0.25)
    real_offset = (-1, 1) # Offsets from where we are looking at
    imag_offset = (-1, 1)
    real_range = real_offset[1] - real_offset[0]
    imag_range = imag_offset[1] - imag_offset[0]
    scale = 3
    real_range *= scale
    imag_range *= scale

    # Set width and height of image depending on aspect ratio
    aspect_ratio = real_range / imag_range
    width = 1024 * 8
    height = int(width * 1 / aspect_ratio)

    cmap = cm.get_cmap("hot")
    # cmap = cm.get_cmap("jet")

    samples = 100000000
    # im = sierpinski(width, height, real_range, imag_range, centered_at, samples, cmap)
    im = pentagon(width, height, real_range, imag_range, centered_at, samples, cmap)
    # im = exploding_hexagon(width, height, real_range, imag_range, centered_at, samples, cmap)
    # im = triangle(width, height, real_range, imag_range, centered_at, samples, cmap)
    # im = dragon(width, height, real_range, imag_range, centered_at, samples, cmap)

    im.save("out.png")

    



