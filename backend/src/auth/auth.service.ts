import {
  Injectable,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private usersService: UsersService,
    private jwtService: JwtService,
  ) {}

  // ─── Sign Up ─────────────────────────────────────────────────
  async signup(dto: SignupDto) {
    // 1. Check if a user with this email already exists
    const existingUser = await this.usersService.findByEmail(dto.email);
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    // 2. Hash the password (bcrypt adds a random salt automatically)
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(dto.password, saltRounds);

    // 3. Create the user in the database
    const user = await this.usersService.create({
      email: dto.email,
      passwordHash,
      name: dto.name,
    });

    // 4. Generate JWT tokens and create a session
    const tokens = await this.generateTokens(user.id, user.email);
    await this.createSession(user.id, tokens.refreshToken);

    return {
      user: { id: user.id, email: user.email, name: user.name },
      ...tokens,
    };
  }

  // ─── Log In ──────────────────────────────────────────────────
  async login(dto: LoginDto) {
    // 1. Find user by email
    const user = await this.usersService.findByEmail(dto.email);
    if (!user) {
      throw new UnauthorizedException('Invalid email');
    }

    // 2. Compare provided password with stored hash
    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Incorrect password');
    }

    // 3. Generate tokens and create a session
    const tokens = await this.generateTokens(user.id, user.email);
    await this.createSession(user.id, tokens.refreshToken);

    return {
      user: { id: user.id, email: user.email, name: user.name },
      ...tokens,
    };
  }

  // ─── Refresh ─────────────────────────────────────────────────
  async refresh(refreshToken: string) {
    // 1. Find the session that holds this refresh token
    const session = await this.prisma.session.findUnique({
      where: { refreshToken },
      include: { user: true },
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // 2. Check if the session has expired
    if (new Date() > session.expiresAt) {
      // Clean up the expired session
      await this.prisma.session.delete({ where: { id: session.id } });
      throw new UnauthorizedException('Refresh token has expired');
    }

    // 3. Rotate: delete old session, create a new one with a fresh refresh token
    await this.prisma.session.delete({ where: { id: session.id } });

    const tokens = await this.generateTokens(session.user.id, session.user.email);
    await this.createSession(session.user.id, tokens.refreshToken);

    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      },
      ...tokens,
    };
  }

  // ─── Log Out ─────────────────────────────────────────────────
  async logout(userId: string, refreshToken: string) {
    // Delete the specific session (the user might be logged in on multiple devices)
    await this.prisma.session.deleteMany({
      where: {
        userId,
        refreshToken,
      },
    });

    return { message: 'Logged out successfully' };
  }

  // ─── Private Helpers ─────────────────────────────────────────

  private async generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_ACCESS_SECRET || 'archflow-access-secret-change-in-production',
        expiresIn: (process.env.JWT_ACCESS_EXPIRY || '15m') as any,
      }),
      // The refresh token is a random UUID — it's not a JWT.
      // We store it in the database and use it to issue new access tokens.
      Promise.resolve(uuidv4()),
    ]);

    return { accessToken, refreshToken };
  }

  private async createSession(userId: string, refreshToken: string) {
    // Calculate expiry (default: 7 days)
    const expiryMs = this.parseExpiry(process.env.JWT_REFRESH_EXPIRY || '7d');
    const expiresAt = new Date(Date.now() + expiryMs);

    return this.prisma.session.create({
      data: {
        userId,
        refreshToken,
        expiresAt,
      },
    });
  }

  private parseExpiry(expiry: string): number {
    const match = expiry.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return 7 * 24 * 60 * 60 * 1000; // default 7 days

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 's': return value * 1000;
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default:  return 7 * 24 * 60 * 60 * 1000;
    }
  }
}
